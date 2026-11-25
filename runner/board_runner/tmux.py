"""A thin wrapper over the tmux CLI, plus reading Claude Code's input line from a pane capture."""

from __future__ import annotations

import subprocess
import time
from collections.abc import Callable, Mapping
from pathlib import Path

_PROMPT_MARKERS = (">", "❯")
_BOX_EDGES = "│┃|"


class Tmux:
    """Session targets use tmux's exact-match form (=name), so board-a never matches board-a-v2."""

    def __init__(self, run: Callable = subprocess.run, sleep: Callable[[float], None] = time.sleep):
        self._run = run
        self._sleep = sleep

    def _tmux(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return self._run(["tmux", *args], capture_output=True, text=True, check=check)

    def has_session(self, name: str) -> bool:
        return self._tmux("has-session", "-t", f"={name}", check=False).returncode == 0

    def new_session(self, name: str, cwd: Path, argv: list[str], env: Mapping[str, str] | None = None) -> None:
        env_args = [arg for key, value in (env or {}).items() for arg in ("-e", f"{key}={value}")]
        self._tmux("new-session", "-d", "-s", name, "-c", str(cwd), *env_args, *argv)

    def send_line(self, name: str, text: str) -> None:
        """Type text into the pane and submit it. A fast burst can be taken as a paste that swallows the Enter, so
        pause first, then check the box and press Enter once more if the text is still there."""
        self._tmux("send-keys", "-t", f"={name}:", "-l", text)
        self._sleep(0.3)
        self._tmux("send-keys", "-t", f"={name}:", "Enter")
        self._sleep(0.5)
        remaining = input_line(self.capture(name))
        if remaining and remaining.strip() == text.strip():
            self._tmux("send-keys", "-t", f"={name}:", "Enter")

    def capture(self, name: str) -> str:
        return self._tmux("capture-pane", "-p", "-t", f"={name}:").stdout

    def kill_session(self, name: str) -> None:
        self._tmux("kill-session", "-t", f"={name}", check=False)


def input_line(capture: str) -> str | None:
    """The text in Claude Code's input box: what follows the prompt marker on the lowest prompt line. None when no
    prompt is visible (a menu, a changed screen): the caller must treat that as "do not type"."""
    for line in reversed(capture.splitlines()):
        stripped = line.strip().strip(_BOX_EDGES).strip()
        for marker in _PROMPT_MARKERS:
            if stripped.startswith(marker + " ") or stripped == marker:
                return stripped[len(marker):].strip().strip(_BOX_EDGES).strip()
    return None
