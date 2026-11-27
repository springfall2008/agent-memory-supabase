"""The lead's Stop hook: record the text of each finished turn, and its transcript path, in events.jsonl.

It must never raise or exit non-zero. A failing Stop hook shows errors in the lead's screen, and exit code 2 would stop
the lead from finishing its turn at all.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

TEXT_CAP = 4000


def last_assistant_text(transcript_path: Path) -> str:
    try:
        lines = Path(transcript_path).read_text().splitlines()
    except (OSError, TypeError, ValueError):
        return ""
    for line in reversed(lines):
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("type") != "assistant":
            continue
        message = record.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        texts = [item.get("text", "") for item in content if isinstance(item, dict) and item.get("type") == "text"]
        texts = [text for text in texts if isinstance(text, str) and text]
        if texts:
            return "\n".join(texts)
    return ""


def hook_stop(events_path: Path, stdin_text: str, now: Callable[[], str]) -> None:
    try:
        try:
            data = json.loads(stdin_text)
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        # Claude Code passes the turn's last message directly; the transcript may not be flushed yet when Stop fires.
        text = data.get("last_assistant_message")
        if not isinstance(text, str) or not text.strip():
            transcript = data.get("transcript_path")
            text = last_assistant_text(Path(transcript)) if isinstance(transcript, str) else ""
        event = {"time": now(), "session_id": data.get("session_id"), "text": text[-TEXT_CAP:]}
        # The runner reads the lead's token counts from this transcript (and its sub-agents') after each turn.
        if isinstance(data.get("transcript_path"), str):
            event["transcript_path"] = data["transcript_path"]
        events_path = Path(events_path)
        events_path.parent.mkdir(parents=True, exist_ok=True)
        with events_path.open("a") as handle:
            handle.write(json.dumps(event) + "\n")
    except Exception:  # noqa: BLE001 - the hook must never fail the lead's turn
        return
