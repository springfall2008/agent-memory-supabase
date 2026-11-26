"""The board runner's scheduler: pure logic, with events in and actions out.

The runner feeds it events (a lead turn ended, a worker exited, a measurement finished, a clock tick, Ctrl-C) and
carries out the actions it returns. It never touches tmux, processes or the clock itself, so every rule is unit-tested.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .board_file import BoardFile, WorkerSlot
from .launch import lead_prompt
from .protocol import LeadResult, WorkResult

BACKOFF_SECONDS = 60
LEAD_BUSY_WARN_SECONDS = 15 * 60
MAX_FAILED_MEASUREMENTS = 5
PAUSED_HEARTBEAT_SECONDS = 120


# --- events --------------------------------------------------------------


@dataclass(frozen=True)
class LeadTurn:
    result: LeadResult


@dataclass(frozen=True)
class WorkerExit:
    slot: int
    result: WorkResult


@dataclass(frozen=True)
class MeasureDone:
    ref: str
    passed: bool
    output: Path


@dataclass(frozen=True)
class Tick:
    pass


@dataclass(frozen=True)
class Interrupt:
    pass


# --- actions -------------------------------------------------------------


@dataclass(frozen=True)
class StartWorker:
    slot: int


@dataclass(frozen=True)
class KillWorker:
    slot: int


@dataclass(frozen=True)
class Release:
    label: str
    minutes: int


@dataclass(frozen=True)
class RunMeasure:
    ref: str


@dataclass(frozen=True)
class Warn:
    message: str


@dataclass(frozen=True)
class Shutdown:
    kill_workers: bool


@dataclass
class _Slot:
    worker: WorkerSlot
    busy: bool = False
    label: str | None = None
    started_at: float | None = None
    not_before: float = 0.0
    killing: bool = False


@dataclass
class _Measurement:
    queue: list[str] = field(default_factory=list)
    current: str | None = None
    done: set[str] = field(default_factory=set)
    results: list[tuple[str, bool, Path]] = field(default_factory=list)
    passed_sent: bool = False
    failures: int = 0


class Scheduler:
    def __init__(self, bf: BoardFile, now: float, lead_label: str):
        self.bf = bf
        self.lead_label = lead_label
        self.slots = [_Slot(worker) for worker in bf.workers]
        # The runner sends the lead's first round as its start prompt, so the lead begins pending.
        self.lead_pending = True
        self.last_sent = now
        self.busy_warned = False
        self.needs_person = False
        self.wanted = False
        self.free_hint = 0
        self.draining = False
        self.lead_paused = False
        self.interrupts = 0
        self.shutdown_sent = False
        self.measure = _Measurement()
        self._next_send: tuple[str, tuple[str, bool, Path] | None] | None = None

    # --- public API ----------------------------------------------------

    def lead_gone(self) -> None:
        """The lead's session no longer exists: start nothing new, and shut down once running work finishes."""
        self.lead_pending = False
        self.draining = True

    def worker_started(self, slot: int, label: str, now: float) -> None:
        state = self.slots[slot]
        state.busy = True
        state.label = label
        state.started_at = now
        state.killing = False

    def on_event(self, event, now: float) -> list:
        if isinstance(event, LeadTurn):
            actions = self._lead_turn(event.result, now)
        elif isinstance(event, WorkerExit):
            actions = self._worker_exit(event.slot, event.result, now)
        elif isinstance(event, MeasureDone):
            actions = self._measure_done(event, now)
        elif isinstance(event, Tick):
            actions = self._tick(now)
        elif isinstance(event, Interrupt):
            return self._interrupt()
        else:
            raise TypeError(f"unknown event {event!r}")
        return actions + self._maybe_shutdown()

    def poll_send(self, now: float) -> str | None:
        """The lead prompt to send now, or None. Call sent() after sending it."""
        self._next_send = None
        if self.lead_pending or self.needs_person or self.draining or self.shutdown_sent:
            return None
        # A paused lead writes nothing, so a result sent to it would never be stored: hold it until it runs again.
        measured = self.measure.results[0] if self.measure.results and not self.lead_paused else None
        heartbeat_due = now - self.last_sent >= self._heartbeat_seconds()
        if measured is None and not self.wanted and not heartbeat_due:
            return None
        prompt = lead_prompt(self.bf.board, self.lead_label, measure=self.bf.measure is not None, measured=measured)
        self._next_send = (prompt, measured)
        return prompt

    def sent(self, now: float) -> None:
        if self._next_send is not None:
            _, measured = self._next_send
            if measured is not None:
                self.measure.results.pop(0)
                if measured[1]:
                    self.measure.passed_sent = True
            self._next_send = None
        self.lead_pending = True
        self.last_sent = now
        self.wanted = False
        self.busy_warned = False

    # --- event handlers ------------------------------------------------

    def _lead_turn(self, result: LeadResult, now: float) -> list:
        if not self.lead_pending and not (self.needs_person and result.kind != "none"):
            return []  # the person's own exchange with the lead: it is idle, nothing more
        self.lead_pending = False
        if result.kind == "none":
            self.needs_person = True
            return [
                Warn(
                    "The lead ended a turn without a BOARD-LEAD line; it may be asking you something. "
                    f"Look with: tmux attach -t board-{self.bf.board}"
                )
            ]
        self.needs_person = False
        self.lead_paused = result.kind == "paused"
        actions: list = []
        if result.kind in ("running", "paused", "candidate"):
            self.free_hint = result.free or 0
            if result.kind == "candidate":
                actions += self._enqueue_candidate(result.ref or "")
            actions += self._fill(now) + self._maybe_start_measure()
        elif result.kind == "done":
            if self.bf.measure is not None and not self.measure.passed_sent:
                actions.append(Warn("The lead concluded without a passing measurement. Check the conclusion."))
            self.draining = True
        elif result.kind == "stopped":
            self.draining = True
        elif result.kind == "outgrown":
            actions.append(Warn("The board's intent list outgrew one read: start a fresh board for the next phase."))
            self.draining = True
        elif result.kind == "refused":
            actions.append(
                Warn(f"Another session holds the lead ({result.holder} until {result.until}). Use --takeover if it is dead.")
            )
            self.draining = True
        return actions

    def _enqueue_candidate(self, ref: str) -> list:
        if self.bf.measure is None:
            return [Warn(f"The lead proposed candidate {ref}, but the board file has no [measure].")]
        m = self.measure
        if ref in m.done:
            return [Warn(f"The lead proposed {ref} again, which was already measured; it should plan on instead.")]
        if ref and ref != m.current and ref not in m.queue:
            m.queue.append(ref)
        return []

    def _worker_exit(self, slot: int, result: WorkResult, now: float) -> list:
        state = self.slots[slot]
        state.busy = False
        state.label = None
        state.started_at = None
        state.killing = False
        if result.kind == "stopped":
            self.draining = True
            return []
        if result.kind in ("partial", "lost"):
            state.not_before = now + BACKOFF_SECONDS
        self.wanted = True
        return self._maybe_start_measure() + self._fill(now)

    def _measure_done(self, event: MeasureDone, now: float) -> list:
        m = self.measure
        m.current = None
        m.done.add(event.ref)
        if not event.passed:
            m.failures += 1
            if m.failures >= MAX_FAILED_MEASUREMENTS:
                # Candidates cost no intents, so a lead that keeps proposing could loop for ever: stop here instead.
                self.draining = True
                return [
                    Warn(
                        f"{MAX_FAILED_MEASUREMENTS} failed measurements: stopping the runner and leaving the board "
                        "running. Check the measurement and the candidates, then run again."
                    )
                ]
        m.results.append((event.ref, event.passed, event.output))
        return self._maybe_start_measure() + self._fill(now)

    def _tick(self, now: float) -> list:
        actions: list = []
        for index, state in enumerate(self.slots):
            if state.busy and not state.killing and state.started_at is not None:
                if now - state.started_at >= state.worker.timeout_minutes * 60:
                    state.killing = True
                    actions += [KillWorker(index), Release(state.label or "", state.worker.timeout_minutes)]
        stuck = self._stuck_seconds()
        if self.lead_pending and now - self.last_sent >= stuck:
            # No Stop event for two heartbeats: the lead was interrupted, is stuck at a prompt, or died mid-turn.
            self.lead_pending = False
            self.needs_person = True
            actions.append(
                Warn(
                    f"The lead has had no turn end for {round(stuck / 60)} minutes; it may need you. "
                    f"Look with: tmux attach -t board-{self.bf.board}"
                )
            )
        if self.lead_pending and not self.busy_warned and now - self.last_sent >= LEAD_BUSY_WARN_SECONDS:
            self.busy_warned = True
            actions.append(
                Warn(f"The lead has been busy for 15 minutes. Look with: tmux attach -t board-{self.bf.board}")
            )
        return actions + self._fill(now)

    def _interrupt(self) -> list:
        self.interrupts += 1
        if self.interrupts == 1:
            self.draining = True
            return self._maybe_shutdown()
        if self.shutdown_sent:
            return []
        self.shutdown_sent = True
        return [KillWorker(i) for i, s in enumerate(self.slots) if s.busy] + [Shutdown(True)]

    # --- helpers --------------------------------------------------------

    def _heartbeat_seconds(self) -> int:
        """How often the lead is asked for a round: at most every 2 minutes while the board is paused, so a resume is
        seen, and never less often than while it runs."""
        running = self.bf.round_every_minutes * 60
        return min(PAUSED_HEARTBEAT_SECONDS, running) if self.lead_paused else running

    def _stuck_seconds(self) -> int:
        """How long a lead turn may run before the lead is taken to need the person: two running heartbeats, and never
        under two paused ones. Pausing shortens the heartbeat, not a turn."""
        return max(2 * PAUSED_HEARTBEAT_SECONDS, 2 * self.bf.round_every_minutes * 60)

    def _exclusive_hold(self) -> bool:
        m = self.measure
        return self.bf.measure is not None and self.bf.measure.exclusive and (m.current is not None or bool(m.queue))

    def _fill(self, now: float) -> list:
        if self.draining or self.shutdown_sent or self._exclusive_hold():
            return []
        actions = []
        for index, state in enumerate(self.slots):
            if self.free_hint <= 0:
                break
            if not state.busy and state.not_before <= now:
                state.busy = True  # reserved until worker_started fills in the label
                self.free_hint -= 1
                actions.append(StartWorker(index))
        return actions

    def _maybe_start_measure(self) -> list:
        m = self.measure
        if m.current is not None or not m.queue or self.bf.measure is None:
            return []
        if self.bf.measure.exclusive and any(s.busy for s in self.slots):
            return []
        m.current = m.queue.pop(0)
        return [RunMeasure(m.current)]

    def _maybe_shutdown(self) -> list:
        if not self.draining or self.shutdown_sent:
            return []
        if any(s.busy for s in self.slots) or self.measure.current is not None or self.lead_pending:
            return []
        self.shutdown_sent = True
        return [Shutdown(False)]
