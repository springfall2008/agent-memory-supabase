import subprocess
import unittest
from pathlib import Path

from board_runner.tmux import Tmux, input_line

FIXTURES = Path(__file__).parent / "fixtures"


class Recorder:
    def __init__(self, returncode=0, stdout=""):
        self.calls = []
        self.returncode = returncode
        self.stdout = stdout

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        return subprocess.CompletedProcess(argv, self.returncode, stdout=self.stdout, stderr="")


class TmuxTest(unittest.TestCase):
    def test_send_line(self):
        run = Recorder()
        Tmux(run, sleep=lambda s: None).send_line("board-b", "/blackboard lead b label=L runner")
        self.assertEqual(
            run.calls,
            [
                ["tmux", "send-keys", "-t", "=board-b:", "-l", "/blackboard lead b label=L runner"],
                ["tmux", "send-keys", "-t", "=board-b:", "Enter"],
                ["tmux", "capture-pane", "-p", "-t", "=board-b:"],
            ],
        )

    def test_has_session(self):
        self.assertTrue(Tmux(Recorder(0)).has_session("x"))
        self.assertFalse(Tmux(Recorder(1)).has_session("x"))

    def test_new_session_and_kill(self):
        run = Recorder()
        tmux = Tmux(run)
        tmux.new_session("board-b", Path("/ws"), ["claude", "--model", "opus", "/blackboard lead b"])
        tmux.kill_session("board-b")
        self.assertEqual(run.calls[0][:7], ["tmux", "new-session", "-d", "-s", "board-b", "-c", "/ws"])
        self.assertEqual(run.calls[0][7:], ["claude", "--model", "opus", "/blackboard lead b"])
        self.assertEqual(run.calls[1], ["tmux", "kill-session", "-t", "=board-b"])

    def test_capture(self):
        run = Recorder(stdout="pane text")
        self.assertEqual(Tmux(run).capture("board-b"), "pane text")
        self.assertEqual(run.calls[0], ["tmux", "capture-pane", "-p", "-t", "=board-b:"])


class InputLineTest(unittest.TestCase):
    def test_empty_prompt(self):
        self.assertEqual(input_line((FIXTURES / "pane-empty.txt").read_text()), "")

    def test_typed_prompt(self):
        self.assertEqual(input_line((FIXTURES / "pane-typed.txt").read_text()), "hello")

    def test_boxed_prompt(self):
        pane = "output\n╭────────────╮\n│ > hello    │\n╰────────────╯\n"
        self.assertEqual(input_line(pane), "hello")




class ReviewFixTmuxTest(unittest.TestCase):
    def test_targets_are_exact(self):
        run = Recorder(stdout="> \n")
        tmux = Tmux(run, sleep=lambda s: None)
        tmux.has_session("board-b")
        tmux.capture("board-b")
        tmux.kill_session("board-b")
        self.assertEqual(run.calls[0], ["tmux", "has-session", "-t", "=board-b"])
        self.assertEqual(run.calls[1], ["tmux", "capture-pane", "-p", "-t", "=board-b:"])
        self.assertEqual(run.calls[2], ["tmux", "kill-session", "-t", "=board-b"])

    def test_send_line_pauses_and_retries_enter_when_text_stays(self):
        pauses = []
        run = Recorder(stdout="────\n> /blackboard lead b\n────\n")
        Tmux(run, sleep=pauses.append).send_line("board-b", "/blackboard lead b")
        enters = [c for c in run.calls if c[-1] == "Enter"]
        self.assertEqual(run.calls[0], ["tmux", "send-keys", "-t", "=board-b:", "-l", "/blackboard lead b"])
        self.assertEqual(len(enters), 2)
        self.assertTrue(pauses and pauses[0] >= 0.3)

    def test_send_line_single_enter_when_box_clears(self):
        run = Recorder(stdout="────\n> \n────\n")
        Tmux(run, sleep=lambda s: None).send_line("board-b", "/blackboard lead b")
        self.assertEqual(len([c for c in run.calls if c[-1] == "Enter"]), 1)

    def test_new_session_passes_environment(self):
        run = Recorder()
        Tmux(run).new_session("board-b", Path("/ws"), ["claude"], env={"ANTHROPIC_AUTH_TOKEN": "ollama"})
        call = run.calls[0]
        self.assertIn("-e", call)
        self.assertEqual(call[call.index("-e") + 1], "ANTHROPIC_AUTH_TOKEN=ollama")
        self.assertEqual(call[-1], "claude")

    def test_unknown_screen_is_none(self):
        self.assertIsNone(input_line("just output\nno marker here\n"))


if __name__ == "__main__":
    unittest.main()
