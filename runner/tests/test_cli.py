import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from board_runner.board_file import Measure, WorkerSlot
from board_runner.cli import Runner, main, prune_worker_logs
from tests.test_launch import board

EMPTY_PANE = "● done\n────────\n> \n────────\n"
TYPED_PANE = "● done\n────────\n> hello\n────────\n"


def result_json(text: str, usage: dict | None = None) -> str:
    record = {"type": "result", "result": text, "is_error": False}
    if usage is not None:
        record.update(usage=usage, num_turns=4, duration_ms=900)
    return json.dumps(record)


USAGE = {"input_tokens": 3, "output_tokens": 40, "cache_read_input_tokens": 500, "cache_creation_input_tokens": 60}


def assistant_line(msg_id: str, out: int) -> str:
    usage = {"input_tokens": 1, "output_tokens": out, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 2}
    return json.dumps({"type": "assistant", "message": {"id": msg_id, "model": "claude-opus-5-5", "usage": usage}}) + "\n"


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
        self.new_session_envs = []

    def has_session(self, name):
        if self.missing:
            raise FileNotFoundError("tmux")
        return self.alive

    def new_session(self, name, cwd, argv, env=None):
        self.alive = True
        self.new_sessions.append(argv)
        self.new_session_envs.append(env or {})

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

    def __init__(self, test, bf, start_text="BOARD-START created g1", alive=False, state=None, ps=None,
                 usage_status=200, env=None, fake_usage=True):
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
        self.group_kills = []
        self.popen_kwargs = []
        self.script = []
        self.steps = 0
        self.usage_calls = []
        self.usage_status = usage_status
        self.worker_usage = None
        self.runner = Runner(
            bf,
            self.home,
            self.tmux,
            popen=self.popen,
            clock=self.clock,
            sleep=self.sleep,
            run=self.run,
            kill_pid=lambda pid, sig: self.killed_pids.append(pid),
            kill_group=self.kill_group,
            runner_script=Path("/r/board-runner"),
            # Never the real sender: a test must not reach a real web-api, whatever the environment holds.
            usage_post=self.usage_post if fake_usage else None,
            env={} if env is None else env,
        )

    def usage_post(self, path, body):
        self.usage_calls.append((path, body))
        return self.usage_status

    def usage_rows(self, role):
        return [body for path, body in self.usage_calls if path == "/usage" and body["role"] == role]

    def kill_group(self, pid, sig):
        self.group_kills.append((pid, sig))
        for proc in self.procs:
            if proc.pid == pid:
                proc.killed = True

    def close(self):
        self.tmp.cleanup()

    @property
    def events(self):
        return self.board_dir / "events.jsonl"

    def lead_says(self, text, transcript=None):
        event = {"time": "t", "session_id": "s", "text": text}
        if transcript is not None:
            event["transcript_path"] = str(transcript)
        with self.events.open("a") as handle:
            handle.write(json.dumps(event) + "\n")

    def at(self, t, fn):
        self.script.append((t, fn))
        self.script.sort(key=lambda item: item[0])

    def popen(self, argv, cwd=None, env=None, stdout=None, stderr=None, **kwargs):
        self.popen_kwargs.append((argv, kwargs))
        is_worker = "-p" in argv and argv[argv.index("-p") + 1].startswith("/blackboard work")
        is_release = "-p" in argv and argv[argv.index("-p") + 1].startswith("/blackboard release")
        if is_worker and stdout is not None:
            text = self.worker_texts.pop(0) if self.worker_texts else "BOARD-WORK none"
            if isinstance(text, bytes):
                stdout.buffer.write(text)
            else:
                stdout.write(result_json(text, self.worker_usage))
            stdout.flush()
        if is_release and stdout not in (None, subprocess.DEVNULL):
            stdout.write(result_json("released", USAGE))
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

    def test_worker_stdout_file_is_jsonl(self):
        h = self.harness()
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=2 open=2"))
        h.at(200, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        logs = sorted(p.name for p in (h.board_dir / "workers").iterdir())
        self.assertTrue(logs)
        self.assertEqual({Path(n).suffix for n in logs}, {".jsonl", ".err"})

    def test_state_records_the_workspace(self):
        h = self.harness()
        h.at(5, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        state = json.loads((h.board_dir / "state.json").read_text())
        self.assertEqual(state["workspace"], str(h.bf.workspace))

    def test_finished_worker_leaves_state(self):
        h = self.harness()
        seen = {}
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=2 open=2"))
        h.at(15, lambda: seen.update(running=json.loads((h.board_dir / "state.json").read_text())["workers"]))
        h.at(100, lambda: seen.update(finished=json.loads((h.board_dir / "state.json").read_text())["workers"]))
        h.at(200, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        self.assertEqual(set(seen["running"]), {"0", "1"})
        self.assertEqual(seen["finished"], {})

    def test_worker_label_is_regenerated_while_a_log_for_it_exists(self):
        h = self.harness(bf=board(workers=(WorkerSlot("haiku", 120),)))
        logs = h.board_dir / "workers"
        logs.mkdir()
        (logs / "3-board-b-aaaa.jsonl").write_text("old\n")
        (logs / "1-board-b-bbbb.json").write_text("{}")
        labels = iter(["board-b-aaaa", "board-b-bbbb", "board-b-cccc"])
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=1 open=1"))
        h.at(200, lambda: h.lead_says("BOARD-LEAD done"))
        with mock.patch("board_runner.cli.new_label", side_effect=lambda b, role: "board-b-lead-abcd" if role == "lead" else next(labels)):
            h.runner.run(takeover=False)
        self.assertEqual((logs / "3-board-b-aaaa.jsonl").read_text(), "old\n")
        self.assertTrue((logs / "0-board-b-cccc.jsonl").exists())
        self.assertFalse((logs / "0-board-b-aaaa.jsonl").exists())
        self.assertFalse((logs / "0-board-b-bbbb.jsonl").exists())

    def test_save_state_replaces_the_file_whole(self):
        h = self.harness()
        h.runner.save_state({"workers": {"0": {"label": "board-b-1234"}}})
        replaced = []
        real_replace = os.replace

        def spy(src, dst):
            src, dst = Path(src), Path(dst)
            # The new content is complete before it takes the state file's name.
            self.assertEqual(json.loads(src.read_text()), {"workers": {}})
            self.assertEqual(json.loads(dst.read_text())["workers"], {"0": {"label": "board-b-1234"}})
            replaced.append((src.parent, dst))
            real_replace(src, dst)

        with mock.patch("board_runner.cli.os.replace", side_effect=spy):
            h.runner.save_state({"workers": {}})
        self.assertEqual(replaced, [(h.board_dir, h.board_dir / "state.json")])
        self.assertEqual(json.loads((h.board_dir / "state.json").read_text()), {"workers": {}})
        self.assertEqual(sorted(p.name for p in h.board_dir.iterdir()), ["state.json"])

    def test_prune_keeps_newest_200(self):
        with tempfile.TemporaryDirectory() as tmp:
            logs = Path(tmp)
            for i in range(250):
                for suffix in (".jsonl", ".err"):
                    path = logs / f"0-run{i:03d}{suffix}"
                    path.write_text("x")
                    os.utime(path, (1000 + i, 1000 + i))
            prune_worker_logs(logs)
            names = {p.name for p in logs.iterdir()}
            self.assertEqual(len(names), 400)
            self.assertNotIn("0-run049.jsonl", names)
            self.assertNotIn("0-run049.err", names)
            self.assertIn("0-run050.jsonl", names)
            self.assertIn("0-run249.err", names)

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

    def test_children_get_their_own_process_group(self):
        bf = board(workers=(WorkerSlot("haiku", 1),), measure=Measure("./m.sh", 0, 30, False))
        h = self.harness(bf=bf)
        h.worker_seconds = 10_000
        h.at(5, lambda: h.lead_says("BOARD-LEAD candidate r1 free=1 open=1"))
        h.at(300, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        kinds = set()
        for argv, kwargs in h.popen_kwargs:
            self.assertTrue(kwargs.get("start_new_session"), argv)
            kinds.add("measure" if argv[:2] == ["bash", "-c"] else argv[argv.index("-p") + 1].split()[1])
        self.assertEqual(kinds, {"work", "measure", "release"})

    def test_timeout_kills_the_process_group(self):
        import signal as sig

        bf = board(workers=(WorkerSlot("haiku", 1),))
        h = self.harness(bf=bf)
        h.worker_seconds = 10_000
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=1 open=1"))
        h.at(200, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        worker = h.workers()[0]
        self.assertIn((worker.pid, sig.SIGTERM), h.group_kills)

    def test_double_interrupt_kills_the_measurement(self):
        bf = board(measure=Measure("./m.sh", 0, 30, False))
        h = self.harness(bf=bf)
        h.at(5, lambda: h.lead_says("BOARD-LEAD candidate r1 free=0 open=0"))

        def slow_measure():
            for proc in h.procs:
                if proc.argv[:2] == ["bash", "-c"]:
                    proc.finish_at = 10_000

        h.at(5.5, slow_measure)
        h.at(20, h.runner.interrupt)
        h.at(21, h.runner.interrupt)
        self.assertEqual(h.runner.run(takeover=False), 0)
        measure = [p for p in h.procs if p.argv[:2] == ["bash", "-c"]][0]
        self.assertTrue(measure.killed)

    def test_lead_session_gone_exits_1(self):
        h = self.harness()
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=0 open=0"))
        h.at(50, lambda: setattr(h.tmux, "alive", False))
        self.assertEqual(h.runner.run(takeover=False), 1)
        self.assertLess(h.clock.now, 200)

    def test_typing_seen_between_sends_blocks_the_next_send(self):
        h = self.harness(bf=board(workers=(WorkerSlot("haiku", 120),)))
        h.worker_seconds = 110
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=1 open=1"))
        h.at(100, lambda: setattr(h.tmux, "pane", TYPED_PANE))
        h.at(110, lambda: setattr(h.tmux, "pane", EMPTY_PANE))  # the person submitted a message
        h.at(135, lambda: self.assertEqual([s for s in h.tmux.sent if s.startswith("/blackboard")], []))
        h.at(150, lambda: self.assertEqual(len([s for s in h.tmux.sent if s.startswith("/blackboard")]), 1))
        h.at(151, lambda: h.lead_says("BOARD-LEAD done"))
        self.assertEqual(h.runner.run(takeover=False), 0)

    def test_unknown_screen_blocks_sends(self):
        h = self.harness()
        h.tmux.pane = "a menu with no prompt marker"
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=0 open=0"))
        h.at(1300, lambda: self.assertEqual([s for s in h.tmux.sent if s.startswith("/blackboard")], []))
        h.at(1301, lambda: setattr(h.tmux, "pane", EMPTY_PANE))
        h.at(1400, lambda: h.lead_says("BOARD-LEAD done"))
        self.assertEqual(h.runner.run(takeover=False), 0)

    def test_second_runner_is_refused(self):
        import fcntl

        h = self.harness()
        lock = (h.board_dir / "lock").open("w")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            self.assertEqual(h.runner.run(takeover=False), 2)
            self.assertEqual(h.oneshots, [])
        finally:
            lock.close()

    def test_undecodable_worker_output_is_lost(self):
        h = self.harness(bf=board(workers=(WorkerSlot("haiku", 120),)))
        h.worker_texts = [b'{"result": "\xff\xfe broken']
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=1 open=1"))
        h.at(200, lambda: h.lead_says("BOARD-LEAD done"))
        self.assertEqual(h.runner.run(takeover=False), 0)

    def test_hook_runs_with_this_python_and_home(self):
        import sys

        h = self.harness()
        h.at(5, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        command = json.loads((h.board_dir / "lead-settings.json").read_text())["hooks"]["Stop"][0]["hooks"][0]["command"]
        self.assertTrue(command.startswith(sys.executable), command)
        self.assertIn(f"--home {h.home}", command)

    def test_trust_dialog_warns_once(self):
        err = io.StringIO()
        h = self.harness()
        h.runner.err = err
        h.tmux.pane = "Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n"
        h.at(30, lambda: setattr(h.tmux, "pane", EMPTY_PANE))
        h.at(40, lambda: h.lead_says("BOARD-LEAD done"))
        self.assertEqual(h.runner.run(takeover=False), 0)
        self.assertEqual(err.getvalue().count("folder trust dialog"), 1)

    def test_ollama_lead_gets_its_environment(self):
        h = self.harness(bf=board(lead_model="ollama:glm-5.3"))
        h.at(5, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        self.assertEqual(h.tmux.new_session_envs[0].get("ANTHROPIC_AUTH_TOKEN"), "ollama")


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


class UsageTest(unittest.TestCase):
    def harness(self, **kwargs):
        bf = kwargs.pop("bf", None) or board(workers=(WorkerSlot("haiku", 120),))
        h = Harness(self, bf, **kwargs)
        self.addCleanup(h.close)
        return h

    def run_one_worker(self, h, text="BOARD-WORK fact confirmed intent=i1"):
        h.worker_texts = [text]
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=1 open=1"))
        h.at(200, lambda: h.lead_says("BOARD-LEAD done"))
        return h.runner.run(takeover=False)

    def test_a_finished_worker_sends_its_counts(self):
        h = self.harness()
        h.worker_usage = USAGE
        self.assertEqual(self.run_one_worker(h), 0)
        [row] = h.usage_rows("worker")
        self.assertEqual(row["scope"], "s")
        self.assertEqual(row["board"], "b")
        self.assertTrue(row["runLabel"].startswith("board-b-"))
        self.assertEqual((row["intentId"], row["outcome"], row["runnerModel"]), ("i1", "fact confirmed", "haiku"))
        self.assertEqual(row["tokens"], {"input": 3, "output": 40, "cacheRead": 500, "cacheWrite": 60})
        self.assertEqual((row["turns"], row["durationMs"]), (4, 900))
        self.assertRegex(row["startedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertRegex(row["endedAt"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual((h.board_dir / "usage-pending.jsonl").read_text(), "")

    def test_a_worker_without_a_result_line_sends_the_summed_messages(self):
        h = self.harness()
        self.run_one_worker(h, (assistant_line("m1", 5) + assistant_line("m1", 5) + assistant_line("m2", 7)).encode())
        [row] = h.usage_rows("worker")
        self.assertEqual(row["tokens"], {"input": 2, "output": 12, "cacheRead": 20, "cacheWrite": 4})
        self.assertEqual((row["outcome"], row["intentId"], row["turns"]), ("lost", None, None))

    def test_a_worker_with_an_empty_transcript_sends_nothing(self):
        h = self.harness()
        self.run_one_worker(h, b"")
        self.assertEqual(h.usage_rows("worker"), [])

    def test_an_orphan_left_by_a_crash_is_counted_at_start(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        transcript = Path(tmp.name) / "0-board-b-dead.jsonl"
        transcript.write_text(result_json("x\nBOARD-WORK fact refuted intent=i9", USAGE))
        state = {"lead_session_id": "s", "lead_label": "L", "workers": {"0": {
            "pid": 12, "label": "board-b-dead", "started_at": 1795766803.5, "path": str(transcript), "model": "opus"}}}
        h = self.harness(state=state, ps={12: "claude -p /blackboard work b label=board-b-dead runner"})
        h.at(5, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        [row] = h.usage_rows("worker")
        self.assertEqual((row["runLabel"], row["outcome"], row["intentId"]), ("board-b-dead", "fact refuted", "i9"))
        self.assertEqual(row["runnerModel"], "opus")
        self.assertEqual(row["tokens"]["output"], 40)

    def test_the_start_and_release_one_shots_are_counted(self):
        bf = board(workers=(WorkerSlot("haiku", 1),))
        h = self.harness(bf=bf)
        h.worker_seconds = 10_000
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=1 open=1"))
        h.at(200, lambda: h.lead_says("BOARD-LEAD done"))
        h.runner.run(takeover=False)
        [start] = h.usage_rows("start")
        self.assertRegex(start["runLabel"], r"^board-b-start-[0-9a-f]{4}$")
        [release] = h.usage_rows("release")
        self.assertRegex(release["runLabel"], r"^board-b-release-[0-9a-f]{4}$")
        self.assertEqual(release["tokens"]["output"], 40)
        self.assertEqual(list((h.board_dir / "oneshots").iterdir()), [])

    def test_the_lead_row_is_replaced_with_growing_totals(self):
        h = self.harness()
        transcript = h.home / "lead.jsonl"

        def turn(text, lines):
            with transcript.open("a") as f:
                f.write(lines)
            h.lead_says(text, transcript)

        h.at(5, lambda: turn("BOARD-LEAD running free=1 open=1", assistant_line("a1", 5)))
        h.at(200, lambda: turn("BOARD-LEAD done", assistant_line("a2", 7)))
        h.runner.run(takeover=False)
        leads = h.usage_rows("lead")
        self.assertGreaterEqual(len(leads), 2)
        self.assertEqual(len({r["runLabel"] for r in leads}), 1, "one lead row, replaced each turn")
        self.assertTrue(leads[0]["runLabel"].startswith("board-b-lead-"))
        self.assertEqual(leads[0]["tokens"]["output"], 5)
        self.assertEqual(leads[-1]["tokens"]["output"], 12)
        self.assertEqual((leads[-1]["intentId"], leads[-1]["outcome"], leads[-1]["runnerModel"]), (None, None, "opus"))

    def test_an_unreachable_route_keeps_the_rows_and_the_board_runs(self):
        h = self.harness(usage_status=404)
        h.worker_usage = USAGE
        self.assertEqual(self.run_one_worker(h), 0)
        pending = [json.loads(line) for line in (h.board_dir / "usage-pending.jsonl").read_text().splitlines()]
        self.assertEqual({r["role"] for r in pending}, {"start", "worker"})

    def test_without_credentials_rows_are_queued_with_one_warning(self):
        h = self.harness(fake_usage=False, env={})
        err = io.StringIO()
        h.runner.err = err
        self.run_one_worker(h)
        self.assertEqual(err.getvalue().count("token usage is queued but not sent"), 1)
        pending = (h.board_dir / "usage-pending.jsonl").read_text().splitlines()
        self.assertEqual(len(pending), 2)


class KilledWorkersUsageTest(unittest.TestCase):
    def test_workers_killed_by_a_double_interrupt_are_counted(self):
        h = Harness(self, board(workers=(WorkerSlot("haiku", 120), WorkerSlot("sonnet", 120))))
        self.addCleanup(h.close)
        h.worker_seconds = 10_000
        h.worker_texts = [(assistant_line("m1", 5)).encode(), (assistant_line("m2", 7)).encode()]
        h.at(5, lambda: h.lead_says("BOARD-LEAD running free=2 open=2"))
        h.at(20, h.runner.interrupt)
        h.at(21, h.runner.interrupt)
        self.assertEqual(h.runner.run(takeover=False), 0)
        rows = h.usage_rows("worker")
        self.assertEqual(sorted(r["tokens"]["output"] for r in rows), [5, 7])
        self.assertEqual({r["outcome"] for r in rows}, {"stopped"})
        self.assertEqual({r["runnerModel"] for r in rows}, {"haiku", "sonnet"})


class ForgetUsageTest(unittest.TestCase):
    def test_forget_usage_posts_the_board_to_the_delete_route(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        ws = Path(tmp.name)
        path = ws / "board.toml"
        path.write_text(f'board = "toy-x"\nscope = "s"\nworkspace = "{ws}"\ngoal = "g"\ndone_when = "d"\nrules = "r"\n[[worker]]\nmodel = "haiku"\n')
        calls = []

        def fake_call(base, token, timeout=5.0):
            def call(p, body):
                calls.append((base, token, p, body))
                return 200, {"deleted": 3}
            return call

        out = io.StringIO()
        env = {"AGENT_MEMORY_TOKEN": "t", "WEB_API_URL": "https://h.example/functions/v1/web-api"}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch("board_runner.cli.http_call", fake_call), mock.patch("sys.stdout", out):
            self.assertEqual(main(["forget-usage", str(path)]), 0)
        self.assertEqual(calls, [("https://h.example/functions/v1/web-api", "t", "/usage/delete", {"scope": "s", "board": "toy-x"})])
        self.assertIn("3", out.getvalue())
