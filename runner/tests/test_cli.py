import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from board_runner.board_file import Measure, WorkerSlot
from board_runner.cli import Runner, main
from tests.test_launch import board

EMPTY_PANE = "● done\n────────\n> \n────────\n"
TYPED_PANE = "● done\n────────\n> hello\n────────\n"


def result_json(text: str) -> str:
    return json.dumps({"type": "result", "result": text, "is_error": False})


class Stop(Exception):
    pass


class FakeTmux:
    def __init__(self, alive=False):
        self.alive = alive
        self.sent = []
        self.new_sessions = []
        self.killed = []
        self.pane = EMPTY_PANE
        self.missing = False

    def has_session(self, name):
        if self.missing:
            raise FileNotFoundError("tmux")
        return self.alive

    def new_session(self, name, cwd, argv):
        self.alive = True
        self.new_sessions.append(argv)

    def send_line(self, name, text):
        self.sent.append(text)

    def capture(self, name):
        return self.pane

    def kill_session(self, name):
        self.alive = False
        self.killed.append(name)


class FakeProc:
    _next_pid = 1000

    def __init__(self, argv, finish_at, clock, returncode=0):
        FakeProc._next_pid += 1
        self.pid = FakeProc._next_pid
        self.argv = argv
        self.finish_at = finish_at
        self.clock = clock
        self.returncode = None
        self._final = returncode
        self.killed = False

    def poll(self):
        if self.returncode is None and (self.killed or self.clock.now >= self.finish_at):
            self.returncode = -9 if self.killed else self._final
        return self.returncode

    def terminate(self):
        self.killed = True

    kill = terminate

    def wait(self, timeout=None):
        return self.poll()


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class Harness:
    """Drives Runner.run with a fake clock; `script` maps a time to a callback run when the clock passes it."""

    def __init__(self, test, bf, start_text="BOARD-START created g1", alive=False, state=None, ps=None):
        self.test = test
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.board_dir = self.home / bf.board
        self.board_dir.mkdir(parents=True)
        if state is not None:
            (self.board_dir / "state.json").write_text(json.dumps(state))
        self.bf = bf
        self.clock = Clock()
        self.tmux = FakeTmux(alive)
        self.procs = []
        self.worker_texts = []
        self.worker_seconds = 30
        self.start_text = start_text
        self.oneshots = []
        self.ps = ps or {}
        self.killed_pids = []
        self.script = []
        self.steps = 0
        self.runner = Runner(
            bf,
            self.home,
            self.tmux,
            popen=self.popen,
            clock=self.clock,
            sleep=self.sleep,
            run=self.run,
            kill_pid=lambda pid, sig: self.killed_pids.append(pid),
            runner_script=Path("/r/board-runner"),
        )

    def close(self):
        self.tmp.cleanup()

    @property
    def events(self):
        return self.board_dir / "events.jsonl"

    def lead_says(self, text):
        with self.events.open("a") as handle:
            handle.write(json.dumps({"time": "t", "session_id": "s", "text": text}) + "\n")

    def at(self, t, fn):
        self.script.append((t, fn))
        self.script.sort(key=lambda item: item[0])

    def popen(self, argv, cwd=None, env=None, stdout=None, stderr=None, **kwargs):
        is_worker = "-p" in argv and argv[argv.index("-p") + 1].startswith("/blackboard work")
        if is_worker and stdout is not None:
            text = self.worker_texts.pop(0) if self.worker_texts else "BOARD-WORK none"
            stdout.write(result_json(text))
            stdout.flush()
        proc = FakeProc(argv, self.clock.now + (self.worker_seconds if is_worker else 1), self.clock)
        self.procs.append(proc)
        return proc

    def run(self, argv, **kwargs):
        if argv[:2] == ["ps", "-p"]:
            command = self.ps.get(int(argv[2]))
            return subprocess.CompletedProcess(argv, 0 if command else 1, stdout=(command or "") + "\n", stderr="")
        self.oneshots.append(argv)
        prompt = argv[argv.index("-p") + 1]
        text = self.start_text if prompt.startswith("/blackboard start") else "released"
        return subprocess.CompletedProcess(argv, 0, stdout=result_json(text), stderr="")

    def sleep(self, seconds):
        self.steps += 1
        if self.steps > 20000:
            raise Stop("runner did not finish")
        self.clock.now += seconds
        while self.script and self.script[0][0] <= self.clock.now:
            _, fn = self.script.pop(0)
            fn()

    def workers(self):
        return [p for p in self.procs if "-p" in p.argv and p.argv[p.argv.index("-p") + 1].startswith("/blackboard work")]


class RunnerTest(unittest.TestCase):
    def harness(self, **kwargs):
        bf = kwargs.pop("bf", None) or board(workers=(WorkerSlot("haiku", 120), WorkerSlot("haiku", 120)))
        h = Harness(self, bf, **kwargs)
        self.addCleanup(h.close)
        return h

    def test_happy_path(self):
        h = self.harness()
        h.worker_texts = ["BOARD-WORK fact confirmed intent=i1", "BOARD-WORK fact confirmed intent=i2"]
        h.at(5, lambda: h.lead_says("planned\nBOARD-LEAD running free=2 open=2"))
        h.at(200, lambda: h.lead_says("BOARD-LEAD done"))
        self.assertEqual(h.runner.run(takeover=False), 0)
        self.assertEqual(len(h.tmux.new_sessions), 1)
        self.assertIn("--session-id", h.tmux.new_sessions[0])
        self.assertTrue(h.tmux.new_sessions[0][-1].startswith("/blackboard lead b label=board-b-lead-"))
        workers = h.workers()
        self.assertEqual(len(workers), 2)
        for proc in workers:
            prompt = proc.argv[proc.argv.index("-p") + 1]
            self.assertIn("label=board-b-", prompt)
            self.assertTrue(prompt.endswith(" runner"))
        rounds = [s for s in h.tmux.sent if s.startswith("/blackboard lead")]
        self.assertEqual(len(rounds), 1)
        self.assertEqual(h.tmux.sent[-1], "/exit")
        self.assertEqual(h.tmux.killed, ["board-b"])
        state = json.loads((h.board_dir / "state.json").read_text())
        self.assertEqual(state["workers"], {})

    def test_reuses_live_lead_session(self):
        state = {"lead_session_id": "sess-1", "lead_label": "board-b-lead-abcd", "workers": {}}
        h = self.harness(alive=True, state=state)
        h.at(1300, lambda: h.lead_says("BOARD-LEAD done"))
        self.assertEqual(h.runner.run(takeover=False), 0)
        self.assertEqual(h.tmux.new_sessions, [])
        self.assertTrue(h.tmux.sent[0].startswith("/blackboard lead b label=board-b-lead-abcd"))
        self.assertEqual(h.tmux.killed, ["board-b"])  # only at shutdown

    def test_resumes_dead_lead_session(self):
        state = {"lead_session_id": "sess-1", "lead_label": "board-b-lead-abcd", "workers": {}}
        h = self.harness(state=state)
        h.at(5, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        argv = h.tmux.new_sessions[0]
        self.assertEqual(argv[argv.index("--resume") + 1], "sess-1")

    def test_orphans_killed_only_when_they_are_board_workers(self):
        state = {"lead_session_id": "s", "lead_label": "L", "workers": {"0": {"pid": 11, "label": "x", "started_at": 0}, "1": {"pid": 12, "label": "y", "started_at": 0}}}
        ps = {11: "/usr/bin/vim notes.txt", 12: "claude -p /blackboard work b label=board-b-1234 runner"}
        h = self.harness(state=state, ps=ps)
        h.at(5, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        self.assertEqual(h.killed_pids, [12])

    def test_start_not_running_exits_1(self):
        h = self.harness(start_text="BOARD-START not-running")
        self.assertEqual(h.runner.run(takeover=False), 1)
        self.assertEqual(h.tmux.new_sessions, [])

    def test_start_without_line_exits_1(self):
        h = self.harness(start_text="I could not find the file")
        self.assertEqual(h.runner.run(takeover=False), 1)

    def test_old_events_are_not_replayed(self):
        h = self.harness()
        h.lead_says("BOARD-LEAD done")  # left over from an earlier run
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=0 open=0"))
        h.at(3000, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        self.assertGreaterEqual(h.clock.now, 3000)

    def test_oneshots_use_hook_free_settings(self):
        h = self.harness()
        h.at(5, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        start = h.oneshots[0]
        settings_path = Path(start[start.index("--settings") + 1])
        self.assertEqual(settings_path.name, "oneshot-settings.json")
        self.assertNotIn("hooks", json.loads(settings_path.read_text()))
        lead_settings = json.loads((h.board_dir / "lead-settings.json").read_text())
        self.assertIn("/r/board-runner hook-stop b", lead_settings["hooks"]["Stop"][0]["hooks"][0]["command"])

    def test_hold_file_blocks_sends(self):
        h = self.harness()
        hold = h.board_dir / "hold"
        h.at(5, lambda: (hold.touch(), h.lead_says("BOARD-LEAD running free=0 open=0")))
        h.at(2000, lambda: self.assertEqual([s for s in h.tmux.sent if s.startswith("/blackboard")], []))
        h.at(2001, lambda: hold.unlink())
        h.at(2100, lambda: self.assertEqual(len([s for s in h.tmux.sent if s.startswith("/blackboard")]), 1))
        h.at(2101, lambda: h.lead_says("BOARD-LEAD done"))
        self.assertEqual(h.runner.run(takeover=False), 0)

    def test_typing_blocks_sends(self):
        h = self.harness()
        h.tmux.pane = TYPED_PANE
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=0 open=0"))

        def typing_again():
            h.tmux.pane = TYPED_PANE.replace("hello", "hello there")

        h.at(1300, typing_again)
        h.at(1320, lambda: self.assertEqual([s for s in h.tmux.sent if s.startswith("/blackboard")], []))
        h.at(1321, lambda: setattr(h.tmux, "pane", EMPTY_PANE))  # the person sent or cleared their text
        h.at(1400, lambda: self.assertEqual(len([s for s in h.tmux.sent if s.startswith("/blackboard")]), 1))
        h.at(1401, lambda: h.lead_says("BOARD-LEAD done"))
        self.assertEqual(h.runner.run(takeover=False), 0)

    def test_tmux_missing_exits_2(self):
        h = self.harness()
        h.tmux.missing = True
        self.assertEqual(h.runner.run(takeover=False), 2)

    def test_double_interrupt_kills_workers(self):
        h = self.harness()
        h.worker_seconds = 10_000
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=2 open=2"))
        h.at(20, h.runner.interrupt)
        h.at(21, h.runner.interrupt)
        self.assertEqual(h.runner.run(takeover=False), 0)
        self.assertTrue(all(p.killed for p in h.workers()))
        self.assertEqual(h.tmux.killed, ["board-b"])

    def test_takeover_flag_reaches_first_prompt(self):
        h = self.harness()
        h.at(5, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=True)
        self.assertTrue(h.tmux.new_sessions[0][-1].endswith(" takeover"))

    def test_worker_timeout_kills_and_releases(self):
        bf = board(workers=(WorkerSlot("haiku", 1),))
        h = self.harness(bf=bf)
        h.worker_seconds = 10_000
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=1 open=1"))
        h.at(200, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        self.assertTrue(h.workers()[0].killed)
        releases = [p for p in h.procs if "-p" in p.argv and p.argv[p.argv.index("-p") + 1].startswith("/blackboard release")]
        self.assertEqual(len(releases), 1)
        self.assertIn("minutes=1", releases[0].argv[releases[0].argv.index("-p") + 1])

    def test_measure_runs_with_candidate(self):
        bf = board(measure=Measure("./m.sh", 0, 30, False))
        h = self.harness(bf=bf)
        h.at(5, lambda: h.lead_says("BOARD-LEAD candidate r1 free=0 open=0"))
        h.at(100, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        measures = [p for p in h.procs if p.argv[:2] == ["bash", "-c"]]
        self.assertEqual(len(measures), 1)
        sends = [s for s in h.tmux.sent if "measured" in s]
        self.assertEqual(len(sends), 1)
        self.assertIn("measured r1 pass output=", sends[0])


class MainTest(unittest.TestCase):
    def test_hook_stop_writes_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            import os

            old = os.environ.get("BOARD_RUNNER_HOME")
            os.environ["BOARD_RUNNER_HOME"] = tmp
            try:
                stdin = io.StringIO("not json")
                self.assertEqual(main(["hook-stop", "b"], stdin=stdin), 0)
                self.assertTrue((Path(tmp) / "b" / "events.jsonl").exists())
            finally:
                if old is None:
                    del os.environ["BOARD_RUNNER_HOME"]
                else:
                    os.environ["BOARD_RUNNER_HOME"] = old


if __name__ == "__main__":
    unittest.main()
