"""A thin wrapper over the tmux CLI, plus reading Claude Code's input line from a pane capture."""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path

_PROMPT_MARKERS = (">", "❯")
_BOX_EDGES = "│┃|"


class Tmux:
    def __init__(self, run: Callable = subprocess.run):
        self._run = run

    def _tmux(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return self._run(["tmux", *args], capture_output=True, text=True, check=check)

    def has_session(self, name: str) -> bool:
        return self._tmux("has-session", "-t", name, check=False).returncode == 0

    def new_session(self, name: str, cwd: Path, argv: list[str]) -> None:
        self._tmux("new-session", "-d", "-s", name, "-c", str(cwd), *argv)

    def send_line(self, name: str, text: str) -> None:
        self._tmux("send-keys", "-t", name, "-l", text)
        self._tmux("send-keys", "-t", name, "Enter")

    def capture(self, name: str) -> str:
        return self._tmux("capture-pane", "-p", "-t", name).stdout

    def kill_session(self, name: str) -> None:
        self._tmux("kill-session", "-t", name, check=False)


def input_line(capture: str) -> str:
    """The text in Claude Code's input box: what follows the prompt marker on the lowest prompt line, or ""."""
    for line in reversed(capture.splitlines()):
        stripped = line.strip().strip(_BOX_EDGES).strip()
        for marker in _PROMPT_MARKERS:
            if stripped.startswith(marker + " ") or stripped == marker:
                return stripped[len(marker):].strip().strip(_BOX_EDGES).strip()
    return ""
