"""board-runner: drive a blackboard board from a board file.

  board-runner run <board file> [--takeover]
  board-runner status <board file>
  board-runner hook-stop <board>      (the lead's Stop hook; reads the hook input on stdin)
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from .board_file import BoardFile, BoardFileError, load_board_file
from .hook import hook_stop
from .launch import lead_argv, lead_env, lead_prompt, lead_settings, model_args_env, new_label, oneshot_argv, worker_argv, worker_env
from .protocol import claude_result_text, parse_lead, parse_start, parse_work
from .scheduler import (
    Interrupt,
    KillWorker,
    LeadTurn,
    MeasureDone,
    Release,
    RunMeasure,
    Scheduler,
    Shutdown,
    StartWorker,
    Tick,
    Warn,
    WorkerExit,
)
from .tmux import TRUST_DIALOG, Tmux, input_line

TYPING_QUIET_SECONDS = 30
KILL_GRACE_SECONDS = 10
ONESHOT_TIMEOUT_SECONDS = 15 * 60
LEAD_CHECK_SECONDS = 10
SCRIPT = Path(__file__).resolve().parent.parent / "board-runner"


def runner_home() -> Path:
    return Path(os.environ.get("BOARD_RUNNER_HOME", "~/.board-runner")).expanduser()


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Runner:
    def __init__(
        self,
        bf: BoardFile,
        home: Path,
        tmux: Tmux,
        popen: Callable = subprocess.Popen,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        run: Callable = subprocess.run,
        kill_pid: Callable[[int, int], None] = os.kill,
        kill_group: Callable[[int, int], None] = os.killpg,
        runner_script: Path = SCRIPT,
        out=sys.stdout,
        err=sys.stderr,
    ):
        self.bf = bf
        self.dir = Path(home) / bf.board
        self.tmux = tmux
        self.popen = popen
        self.clock = clock
        self.sleep = sleep
        self.run_cmd = run
        self.kill_pid = kill_pid
        self.kill_group = kill_group
        self.home = Path(home)
        self.lock_handle = None
        self.lead_dead = False
        self.last_lead_check = 0.0
        self.trust_warned = False
        self.runner_script = runner_script
        self.out = out
        self.err = err
        self.session = f"board-{bf.board}"
        self.interrupts_pending = 0
        self.workers: dict[int, dict] = {}
        self.releases: list = []
        self.measure_proc: dict | None = None
        self.measure_count = 0
        self.events_offset = 0
        self.typing_value: str | None = None  # last input-box text seen, and since when
        self.typing_since = 0.0

    # --- small helpers ---------------------------------------------------

    @property
    def state_path(self) -> Path:
        return self.dir / "state.json"

    @property
    def events_path(self) -> Path:
        return self.dir / "events.jsonl"

    def log(self, message: str, warn: bool = False) -> None:
        line = f"[{_iso_now()}] {message}"
        print(line, file=self.err if warn else self.out, flush=True)
        try:
            with (self.dir / "runner.log").open("a") as handle:
                handle.write(line + "\n")
        except OSError:
            pass

    def load_state(self) -> dict:
        try:
            state = json.loads(self.state_path.read_text())
            return state if isinstance(state, dict) else {}
        except (OSError, ValueError):
            return {}

    def save_state(self, state: dict) -> None:
        self.state_path.write_text(json.dumps(state, indent=2))

    def interrupt(self, *_args) -> None:
        self.interrupts_pending += 1

    # --- start-up --------------------------------------------------------

    def _kill_orphans(self, state: dict) -> None:
        marker = f"/blackboard work {self.bf.board} "
        for entry in (state.get("workers") or {}).values():
            pid = entry.get("pid") if isinstance(entry, dict) else None
            if not isinstance(pid, int):
                continue
            ps = self.run_cmd(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, check=False)
            if ps.returncode == 0 and marker in ps.stdout:
                self.log(f"killing worker {pid} left by an earlier run")
                try:
                    self.kill_pid(pid, signal.SIGTERM)
                except OSError:
                    pass

    def _oneshot(self, prompt: str) -> str | None:
        argv = oneshot_argv(self.bf, prompt, self.dir / "oneshot-settings.json")
        try:
            result = self.run_cmd(
                argv,
                cwd=str(self.bf.workspace),
                env=lead_env(self.bf),
                capture_output=True,
                text=True,
                check=False,
                timeout=ONESHOT_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return None
        return claude_result_text(result.stdout or "")

    def _write_settings(self) -> None:
        # The hook runs under the tmux server's environment: pin the interpreter and the runner home explicitly.
        hook = [sys.executable, str(self.runner_script), "hook-stop", self.bf.board, "--home", str(self.home)]
        (self.dir / "lead-settings.json").write_text(json.dumps(lead_settings(hook, self.dir), indent=2))
        (self.dir / "oneshot-settings.json").write_text(json.dumps(lead_settings(None, self.dir), indent=2))

    # --- the run ---------------------------------------------------------

    def _lock(self) -> bool:
        self.lock_handle = (self.dir / "lock").open("w")
        try:
            fcntl.flock(self.lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock_handle.close()
            self.lock_handle = None
            return False
        return True

    def run(self, takeover: bool = False) -> int:
        self.dir.mkdir(parents=True, exist_ok=True)
        if not self._lock():
            self.log(f"another board-runner is already running board {self.bf.board}", warn=True)
            return 2
        try:
            lead_alive = self.tmux.has_session(self.session)
        except FileNotFoundError:
            self.log("tmux is not installed: install tmux (brew install tmux)", warn=True)
            return 2

        self._write_settings()
        self.events_offset = self.events_path.stat().st_size if self.events_path.exists() else 0
        state = self.load_state()
        self._kill_orphans(state)
        state["workers"] = {}

        start = parse_start(self._oneshot(f"/blackboard start {self.bf.board} from={self.bf.path}"))
        for line in start.text.splitlines():
            if line.strip() and not line.startswith("BOARD-START"):
                self.log(f"start: {line}")
        if start.kind in ("not-running", "lost"):
            self.log(f"the board cannot run (start said: {start.kind}); see the lines above", warn=True)
            return 1
        self.log(f"board {self.bf.board}: {start.kind}")

        label = state.get("lead_label") or new_label(self.bf.board, "lead")
        session_id = state.get("lead_session_id")
        resume = bool(session_id)
        session_id = session_id or str(uuid.uuid4())
        state.update({"lead_label": label, "lead_session_id": session_id})
        self.save_state(state)

        now = self.clock()
        scheduler = Scheduler(self.bf, now, label)
        first = lead_prompt(self.bf.board, label, measure=self.bf.measure is not None, takeover=takeover)
        self.first_prompt = None
        if lead_alive:
            # The live lead is idle between turns: send it this run's first round through the normal guarded path.
            self.log(f"reusing the live lead session {self.session}")
            scheduler.lead_pending = False
            scheduler.wanted = True
            self.first_prompt = first
        else:
            argv = lead_argv(self.bf, session_id, resume, self.dir / "lead-settings.json", first)
            _, lead_overrides = model_args_env(self.bf.lead_model, {})
            self.tmux.new_session(self.session, self.bf.workspace, argv, env=lead_overrides)
            self.log(f"lead started in tmux session {self.session} (watch: tmux attach -t {self.session})")

        previous = signal.getsignal(signal.SIGINT)
        try:
            signal.signal(signal.SIGINT, self.interrupt)
        except ValueError:
            previous = None  # not the main thread (tests)
        try:
            return self._loop(scheduler, state)
        finally:
            if previous is not None:
                signal.signal(signal.SIGINT, previous)
            if self.lock_handle is not None:
                self.lock_handle.close()

    def _loop(self, scheduler: Scheduler, state: dict) -> int:
        while True:
            now = self.clock()
            actions: list = []
            for text in self._new_lead_texts():
                actions += scheduler.on_event(LeadTurn(parse_lead(text)), now)
            actions += self._poll_workers(scheduler, now)
            actions += self._poll_measure(scheduler, now)
            while self.interrupts_pending:
                self.interrupts_pending -= 1
                self.log("Ctrl-C: finishing running workers, then exiting (Ctrl-C again to kill them)")
                actions += scheduler.on_event(Interrupt(), now)
            actions += scheduler.on_event(Tick(), now)
            self._reap_releases()
            actions += self._check_lead(scheduler, now)
            self._sample_input(now)

            if scheduler.poll_send(now) is not None and self._may_send(now):
                prompt = scheduler.poll_send(now)
                if self.first_prompt is not None:
                    prompt, self.first_prompt = self.first_prompt, None
                self.tmux.send_line(self.session, prompt)
                scheduler.sent(now)
                self.log(f"lead: {prompt}")

            for action in actions:
                if self._do(action, scheduler, state, now):
                    return 1 if self.lead_dead else 0
            self.sleep(1)

    # --- events in -------------------------------------------------------

    def _new_lead_texts(self) -> list[str]:
        if not self.events_path.exists():
            return []
        with self.events_path.open() as handle:
            handle.seek(self.events_offset)
            chunk = handle.read()
        complete, _, _rest = chunk.rpartition("\n")
        if not complete and not chunk.endswith("\n"):
            return []
        self.events_offset += len((complete + "\n").encode())
        texts = []
        for line in complete.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                texts.append(event.get("text") or "")
        return texts

    def _poll_workers(self, scheduler: Scheduler, now: float) -> list:
        actions = []
        for slot, worker in list(self.workers.items()):
            proc = worker["proc"]
            if proc.poll() is None:
                if worker.get("kill_at") and now >= worker["kill_at"]:
                    self._signal_group(proc, signal.SIGKILL)
                continue
            worker["stdout"].close()
            try:
                text = claude_result_text(Path(worker["path"]).read_text(errors="replace"))
            except (OSError, ValueError):
                text = None
            result = parse_work(text)
            self.log(f"worker {slot} ({worker['label']}) exited {proc.returncode}: {result.kind}")
            del self.workers[slot]
            actions += scheduler.on_event(WorkerExit(slot, result), now)
        return actions

    def _poll_measure(self, scheduler: Scheduler, now: float) -> list:
        m = self.measure_proc
        if m is None:
            return []
        proc = m["proc"]
        if proc.poll() is None:
            if now >= m["deadline"]:
                self.log(f"measurement of {m['ref']} timed out", warn=True)
                self._signal_group(proc, signal.SIGKILL)
            return []
        m["handle"].close()
        passed = proc.returncode == self.bf.measure.pass_exit_code and now < m["deadline"]
        self.log(f"measurement of {m['ref']}: {'pass' if passed else 'fail'} ({m['path']})")
        self.measure_proc = None
        return scheduler.on_event(MeasureDone(m["ref"], passed, m["path"]), now)

    def _reap_releases(self) -> None:
        self.releases = [proc for proc in self.releases if proc.poll() is None]

    def _check_lead(self, scheduler: Scheduler, now: float) -> list:
        if self.lead_dead or now - self.last_lead_check < LEAD_CHECK_SECONDS:
            return []
        self.last_lead_check = now
        try:
            alive = self.tmux.has_session(self.session)
        except (OSError, subprocess.SubprocessError):
            return []
        if alive:
            return []
        self.lead_dead = True
        scheduler.lead_gone()
        return [
            Warn(
                f"The lead's tmux session {self.session} has ended. Finishing running workers, then exiting; "
                "run again to restart the lead (it resumes the same conversation)."
            )
        ] + scheduler.on_event(Tick(), now)

    def _sample_input(self, now: float) -> None:
        """Watch the lead's input box on every loop, so typing between sends is seen too."""
        if self.lead_dead:
            return
        try:
            pane = self.tmux.capture(self.session)
        except (OSError, subprocess.SubprocessError):
            pane = ""
        if TRUST_DIALOG in pane and not self.trust_warned:
            self.trust_warned = True
            self.log(
                f"The lead is waiting at Claude Code's folder trust dialog: attach with tmux attach -t {self.session} "
                "and choose to trust the workspace (runs in that folder are trusted from then on).",
                warn=True,
            )
        current = input_line(pane) if pane else None
        if current != self.typing_value or current is None:
            self.typing_value = current
            self.typing_since = now

    def _may_send(self, now: float) -> bool:
        """No hold file, a visible and empty input box, and no change to it for TYPING_QUIET_SECONDS."""
        if (self.dir / "hold").exists() or self.lead_dead:
            return False
        return self.typing_value == "" and now - self.typing_since >= TYPING_QUIET_SECONDS

    # --- actions out -----------------------------------------------------

    def _do(self, action, scheduler: Scheduler, state: dict, now: float) -> bool:
        if isinstance(action, StartWorker):
            self._start_worker(action.slot, scheduler, state, now)
        elif isinstance(action, KillWorker):
            worker = self.workers.get(action.slot)
            if worker:
                self.log(f"stopping worker {action.slot} ({worker['label']})")
                self._signal_group(worker["proc"], signal.SIGTERM)
                worker["kill_at"] = now + KILL_GRACE_SECONDS
        elif isinstance(action, Release):
            prompt = f"/blackboard release {self.bf.board} label={action.label} minutes={action.minutes}"
            argv = oneshot_argv(self.bf, prompt, self.dir / "oneshot-settings.json")
            self.releases.append(
                self.popen(
                    argv,
                    cwd=str(self.bf.workspace),
                    env=lead_env(self.bf),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            )
            self.log(f"releasing the claims of {action.label}")
        elif isinstance(action, RunMeasure):
            self._start_measure(action.ref, now)
        elif isinstance(action, Warn):
            self.log(action.message, warn=True)
        elif isinstance(action, Shutdown):
            self._shutdown(action.kill_workers, state)
            return True
        return False

    def _signal_group(self, proc, sig: int) -> None:
        try:
            self.kill_group(proc.pid, sig)
        except (OSError, ProcessLookupError):
            pass

    def _start_worker(self, slot: int, scheduler: Scheduler, state: dict, now: float) -> None:
        spec = self.bf.workers[slot]
        label = new_label(self.bf.board, "worker")
        logs = self.dir / "workers"
        logs.mkdir(exist_ok=True)
        path = logs / f"{slot}-{label}.json"
        stdout = path.open("w")
        stderr = (logs / f"{slot}-{label}.err").open("w")
        proc = self.popen(
            worker_argv(self.bf, spec, label),
            cwd=str(self.bf.workspace),
            env=worker_env(spec),
            stdout=stdout,
            stderr=stderr,
            # Its own process group: Ctrl-C in the runner's terminal must not reach it, and a kill reaches its children.
            start_new_session=True,
        )
        stderr.close()
        self.workers[slot] = {"proc": proc, "label": label, "path": path, "stdout": stdout}
        scheduler.worker_started(slot, label, now)
        state.setdefault("workers", {})[str(slot)] = {"pid": proc.pid, "label": label, "started_at": time.time()}
        self.save_state(state)
        self.log(f"worker {slot} started: {spec.model} {label}")

    def _start_measure(self, ref: str, now: float) -> None:
        self.measure_count += 1
        logs = self.dir / "measure"
        logs.mkdir(exist_ok=True)
        path = logs / f"{self.measure_count}.log"
        handle = path.open("w")
        env = dict(os.environ, BOARD_CANDIDATE=ref)
        proc = self.popen(
            ["bash", "-c", self.bf.measure.command],
            cwd=str(self.bf.workspace),
            env=env,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.measure_proc = {
            "proc": proc,
            "ref": ref,
            "path": path,
            "handle": handle,
            "deadline": now + self.bf.measure.timeout_minutes * 60,
        }
        self.log(f"measuring candidate {ref} ({path})")

    def _shutdown(self, kill_workers: bool, state: dict) -> None:
        if kill_workers:
            for worker in self.workers.values():
                self._signal_group(worker["proc"], signal.SIGKILL)
            if self.measure_proc is not None:
                self._signal_group(self.measure_proc["proc"], signal.SIGKILL)
        try:
            self.tmux.send_line(self.session, "/exit")
        except (OSError, subprocess.SubprocessError):
            pass
        self.tmux.kill_session(self.session)
        state["workers"] = {}
        self.save_state(state)
        self.log("runner finished")


def _status(path: Path) -> int:
    bf = load_board_file(path)
    board_dir = runner_home() / bf.board
    state = board_dir / "state.json"
    print(state.read_text() if state.exists() else "no state yet")
    print(f"tmux session board-{bf.board}: {'alive' if Tmux().has_session(f'board-{bf.board}') else 'not running'}")
    return 0


def main(argv: list[str] | None = None, stdin=None) -> int:
    parser = argparse.ArgumentParser(prog="board-runner", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a board until it is done or stopped")
    run.add_argument("board_file", type=Path)
    run.add_argument("--takeover", action="store_true", help="take the lead role from a session that is dead")
    status = sub.add_parser("status", help="show the runner's state for a board")
    status.add_argument("board_file", type=Path)
    hook = sub.add_parser("hook-stop", help="the lead's Stop hook (reads the hook input on stdin)")
    hook.add_argument("board")
    hook.add_argument("--home", type=Path, default=None)
    args = parser.parse_args(argv)

    if args.command == "hook-stop":
        text = (stdin or sys.stdin).read()
        hook_stop((args.home or runner_home()) / args.board / "events.jsonl", text, _iso_now)
        return 0
    try:
        if args.command == "status":
            return _status(args.board_file)
        bf = load_board_file(args.board_file)
    except BoardFileError as exc:
        print(f"board file: {exc}", file=sys.stderr)
        return 2
    return Runner(bf, runner_home(), Tmux()).run(takeover=args.takeover)
