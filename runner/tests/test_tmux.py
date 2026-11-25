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
        Tmux(run).send_line("board-b", "/blackboard lead b label=L runner")
        self.assertEqual(
            run.calls,
            [
                ["tmux", "send-keys", "-t", "board-b", "-l", "/blackboard lead b label=L runner"],
                ["tmux", "send-keys", "-t", "board-b", "Enter"],
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
        self.assertEqual(run.calls[1], ["tmux", "kill-session", "-t", "board-b"])

    def test_capture(self):
        run = Recorder(stdout="pane text")
        self.assertEqual(Tmux(run).capture("board-b"), "pane text")
        self.assertEqual(run.calls[0], ["tmux", "capture-pane", "-p", "-t", "board-b"])


class InputLineTest(unittest.TestCase):
    def test_empty_prompt(self):
        self.assertEqual(input_line((FIXTURES / "pane-empty.txt").read_text()), "")

    def test_typed_prompt(self):
        self.assertEqual(input_line((FIXTURES / "pane-typed.txt").read_text()), "hello")

    def test_boxed_prompt(self):
        pane = "output\n╭────────────╮\n│ > hello    │\n╰────────────╯\n"
        self.assertEqual(input_line(pane), "hello")

    def test_no_prompt(self):
        self.assertEqual(input_line("just output\nno marker here\n"), "")


if __name__ == "__main__":
    unittest.main()
