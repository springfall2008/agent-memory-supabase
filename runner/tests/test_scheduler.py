import unittest
from pathlib import Path

from board_runner.board_file import Measure, WorkerSlot
from board_runner.protocol import LeadResult, WorkResult
from board_runner.scheduler import (
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
from tests.test_launch import board

ROUND = "/blackboard lead b label=LL runner"


def running(free, open_=None):
    return LeadTurn(LeadResult("running", free=free, open=free if open_ is None else open_))


def fact():
    return WorkResult("fact", "confirmed", "i1")


def starts(actions):
    return [a for a in actions if isinstance(a, StartWorker)]


def warns(actions):
    return [a for a in actions if isinstance(a, Warn)]


class SchedulerTest(unittest.TestCase):
    def make(self, measure=None, workers=2):
        bf = board(
            workers=tuple(WorkerSlot("haiku", 120) for _ in range(workers)),
            measure=measure,
            round_every_minutes=20,
            claim_minutes=60,
        )
        return Scheduler(bf, 0.0, "LL")

    def start(self, s, slot, now, label=None):
        s.worker_started(slot, label or f"W{slot}", now)

    def send(self, s, now):
        prompt = s.poll_send(now)
        self.assertIsNotNone(prompt)
        s.sent(now)
        return prompt

    # --- refilling slots -------------------------------------------------

    def test_round_fills_free_slots(self):
        s = self.make()
        self.assertEqual(s.on_event(running(1, 2), 1), [StartWorker(0)])
        s2 = self.make()
        self.assertEqual(s2.on_event(running(5), 1), [StartWorker(0), StartWorker(1)])

    def test_fact_restarts_slot_when_free_hint_left(self):
        s = self.make(workers=1)
        s.on_event(running(2), 1)
        self.start(s, 0, 1)
        self.assertEqual(starts(s.on_event(WorkerExit(0, fact()), 10)), [StartWorker(0)])
        self.assertEqual(s.poll_send(10), ROUND)

    def test_fact_without_free_hint_wants_round(self):
        s = self.make(workers=1)
        s.on_event(running(1), 1)
        self.start(s, 0, 1)
        self.assertEqual(starts(s.on_event(WorkerExit(0, fact()), 10)), [])
        self.assertEqual(s.poll_send(10), ROUND)

    def test_none_wants_round(self):
        s = self.make(workers=1)
        s.on_event(running(1), 1)
        self.start(s, 0, 1)
        self.assertEqual(starts(s.on_event(WorkerExit(0, WorkResult("none")), 10)), [])
        self.assertEqual(s.poll_send(10), ROUND)

    def test_lost_backs_off_sixty_seconds(self):
        s = self.make(workers=1)
        s.on_event(running(1), 1)
        self.start(s, 0, 1)
        s.on_event(WorkerExit(0, WorkResult("lost")), 100)
        self.send(s, 100)
        self.assertEqual(starts(s.on_event(running(1), 130)), [])
        self.assertEqual(starts(s.on_event(Tick(), 159)), [])
        self.assertEqual(starts(s.on_event(Tick(), 161)), [StartWorker(0)])

    # --- sending lead rounds ---------------------------------------------

    def test_wants_collapse_into_one_round(self):
        s = self.make()
        self.assertIsNone(s.poll_send(1))  # pending: the start prompt is out
        s.on_event(running(2), 1)
        self.start(s, 0, 1)
        self.start(s, 1, 1)
        self.send(s, 1201)  # heartbeat round: the lead is pending again
        s.on_event(WorkerExit(0, fact()), 1205)
        s.on_event(WorkerExit(1, fact()), 1206)
        self.assertIsNone(s.poll_send(3000))  # still pending, even past the next heartbeat
        s.on_event(running(0), 3001)
        self.assertEqual(self.send(s, 3001), ROUND)
        self.assertIsNone(s.poll_send(3002))

    def test_heartbeat(self):
        s = self.make()
        s.on_event(running(0), 0)
        self.assertIsNone(s.poll_send(1199))
        self.assertEqual(s.poll_send(1200), ROUND)

    def test_pending_blocks_sends(self):
        s = self.make()
        s.on_event(running(0), 0)
        self.send(s, 1200)
        self.assertIsNone(s.poll_send(5000))

    def test_turn_without_line_needs_the_person(self):
        s = self.make()
        actions = s.on_event(LeadTurn(LeadResult("none")), 10)
        self.assertEqual(len(warns(actions)), 1)
        self.assertIn("tmux attach -t board-b", warns(actions)[0].message)
        self.assertIsNone(s.poll_send(10 + 1800))
        self.assertEqual(starts(s.on_event(running(1), 2000)), [StartWorker(0)])
        self.assertIsNotNone(s.poll_send(2000 + 1200))

    def test_persons_own_turn_is_only_idle(self):
        s = self.make()
        s.on_event(running(0), 0)
        self.assertEqual(starts(s.on_event(running(3), 50)), [])

    # --- timeouts and the busy lead ----------------------------------------

    def test_worker_timeout_kills_and_releases_once(self):
        s = self.make()
        s.on_event(running(1), 0)
        self.start(s, 0, 0, "W0")
        self.assertEqual(s.on_event(Tick(), 7199), [])
        self.assertEqual(s.on_event(Tick(), 7200), [KillWorker(0), Release("W0", 120)])
        self.assertEqual(s.on_event(Tick(), 7201), [])

    def test_lead_busy_warns_once(self):
        s = self.make()
        self.assertEqual(warns(s.on_event(Tick(), 899)), [])
        self.assertEqual(len(warns(s.on_event(Tick(), 900))), 1)
        self.assertEqual(warns(s.on_event(Tick(), 1500)), [])

    # --- measurement ---------------------------------------------------

    def test_candidate_not_exclusive(self):
        s = self.make(measure=Measure("./m.sh", 0, 30, False))
        actions = s.on_event(LeadTurn(LeadResult("candidate", free=1, open=1, ref="r")), 1)
        self.assertEqual(actions, [StartWorker(0), RunMeasure("r")])
        s.on_event(MeasureDone("r", False, Path("/m/1.log")), 50)
        self.assertEqual(
            self.send(s, 50),
            "/blackboard lead b label=LL runner measure measured r fail output=/m/1.log",
        )
        again = s.on_event(LeadTurn(LeadResult("candidate", free=0, open=1, ref="r")), 60)
        self.assertNotIn(RunMeasure("r"), again)

    def test_candidates_measured_one_at_a_time(self):
        s = self.make(measure=Measure("./m.sh", 0, 30, False))
        s.on_event(LeadTurn(LeadResult("candidate", free=0, open=0, ref="r")), 1)
        self.send(s, 1200)
        queued = s.on_event(LeadTurn(LeadResult("candidate", free=0, open=0, ref="s")), 1201)
        self.assertNotIn(RunMeasure("s"), queued)
        self.assertIn(RunMeasure("s"), s.on_event(MeasureDone("r", False, Path("/m/1.log")), 1300))

    def test_candidate_exclusive_waits_for_workers(self):
        s = self.make(measure=Measure("./m.sh", 0, 30, True), workers=1)
        s.on_event(running(1), 0)
        self.start(s, 0, 0)
        self.send(s, 1200)
        actions = s.on_event(LeadTurn(LeadResult("candidate", free=1, open=1, ref="r")), 1201)
        self.assertEqual(starts(actions), [])
        self.assertNotIn(RunMeasure("r"), actions)
        exit_actions = s.on_event(WorkerExit(0, fact()), 1300)
        self.assertIn(RunMeasure("r"), exit_actions)
        self.assertEqual(starts(exit_actions), [])
        self.assertEqual(starts(s.on_event(MeasureDone("r", True, Path("/m/1.log")), 1400)), [StartWorker(0)])

    def test_prompts_mention_measure_only_when_configured(self):
        s = self.make()
        s.on_event(running(0), 0)
        self.assertNotIn(" measure", self.send(s, 1200))
        actions = s.on_event(LeadTurn(LeadResult("candidate", free=0, open=0, ref="r")), 1201)
        self.assertEqual(len(warns(actions)), 1)
        self.assertFalse(any(isinstance(a, RunMeasure) for a in actions))
        m = self.make(measure=Measure("./m.sh", 0, 30, False))
        m.on_event(running(0), 0)
        self.assertTrue(m.poll_send(1200).endswith(" measure"))

    def test_done_without_pass_warns(self):
        s = self.make(measure=Measure("./m.sh", 0, 30, False))
        self.assertEqual(len(warns(s.on_event(LeadTurn(LeadResult("done")), 1))), 1)

    def test_done_after_pass_does_not_warn(self):
        s = self.make(measure=Measure("./m.sh", 0, 30, False))
        s.on_event(LeadTurn(LeadResult("candidate", free=0, open=0, ref="r")), 1)
        s.on_event(MeasureDone("r", True, Path("/m/1.log")), 2)
        self.send(s, 2)
        self.assertEqual(warns(s.on_event(LeadTurn(LeadResult("done")), 3)), [])

    # --- draining, refusal and interrupts ----------------------------------

    def test_drain_on_terminal_lines(self):
        for result in (LeadResult("done"), LeadResult("stopped"), LeadResult("outgrown")):
            with self.subTest(kind=result.kind):
                s = self.make()
                s.on_event(running(1), 0)
                self.start(s, 0, 0)
                self.send(s, 1200)
                actions = s.on_event(LeadTurn(result), 1201)
                self.assertEqual(starts(actions), [])
                self.assertNotIn(Shutdown(False), actions)
                if result.kind == "outgrown":
                    self.assertIn("fresh board", warns(actions)[0].message)
                self.assertEqual(s.on_event(WorkerExit(0, fact()), 1300)[-1], Shutdown(False))
                self.assertIsNone(s.poll_send(9999))

    def test_worker_stopped_drains(self):
        s = self.make(workers=1)
        s.on_event(running(1), 0)
        self.start(s, 0, 0)
        self.assertEqual(s.on_event(WorkerExit(0, WorkResult("stopped")), 10), [Shutdown(False)])

    def test_refused(self):
        s = self.make()
        actions = s.on_event(LeadTurn(LeadResult("refused", holder="other", until="t")), 1)
        self.assertIn("other", warns(actions)[0].message)
        self.assertEqual(actions[-1], Shutdown(False))

    def test_interrupt_once_drains_twice_kills(self):
        s = self.make()
        s.on_event(running(2), 0)
        self.start(s, 0, 0)
        self.start(s, 1, 0)
        self.assertEqual(s.on_event(Interrupt(), 10), [])
        self.assertEqual(s.on_event(Interrupt(), 11), [KillWorker(0), KillWorker(1), Shutdown(True)])

    def test_interrupt_once_with_nothing_running_shuts_down(self):
        s = self.make()
        s.on_event(running(0), 0)
        self.assertEqual(s.on_event(Interrupt(), 10), [Shutdown(False)])


if __name__ == "__main__":
    unittest.main()
