"""Parse the BOARD- lines that blackboard sessions end with in runner mode.

Each parser scans the text bottom-up and uses the first line that starts with its prefix, so a model that adds a
sentence after the line still counts. A missing or malformed line is a distinct result (lost or none), never an error.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Literal

WorkKind = Literal["fact", "none", "partial", "stopped", "lost"]
LeadKind = Literal["running", "paused", "candidate", "done", "stopped", "outgrown", "refused", "none"]
StartKind = Literal["created", "exists", "resumed", "not-running", "lost"]


@dataclass(frozen=True)
class WorkResult:
    kind: WorkKind
    verdict: str | None = None
    intent: str | None = None


@dataclass(frozen=True)
class LeadResult:
    kind: LeadKind
    free: int | None = None
    open: int | None = None
    ref: str | None = None
    holder: str | None = None
    until: str | None = None


@dataclass(frozen=True)
class StartResult:
    kind: StartKind
    goal_id: str | None = None
    text: str = ""


_WORK = {
    "fact": re.compile(r"^BOARD-WORK fact (confirmed|refuted|inconclusive) intent=(\S+)$"),
    "none": re.compile(r"^BOARD-WORK none$"),
    "partial": re.compile(r"^BOARD-WORK partial intent=(\S+)$"),
    "stopped": re.compile(r"^BOARD-WORK stopped$"),
}
_LEAD_RUNNING = re.compile(r"^BOARD-LEAD running free=(\d+) open=(\d+)$")
_LEAD_PAUSED = re.compile(r"^BOARD-LEAD paused free=(\d+) open=(\d+)$")
_LEAD_CANDIDATE = re.compile(r"^BOARD-LEAD candidate (\S+) free=(\d+) open=(\d+)$")
_LEAD_PLAIN = re.compile(r"^BOARD-LEAD (done|stopped|outgrown)$")
_LEAD_REFUSED = re.compile(r"^BOARD-LEAD refused (\S+) (\S+)$")
_START_CREATED = re.compile(r"^BOARD-START created (\S+)$")
_START_PLAIN = re.compile(r"^BOARD-START (exists|resumed|not-running)$")


def _prefixed_line(text: str | None, prefix: str) -> str | None:
    if not text:
        return None
    for line in reversed(text.splitlines()):
        stripped = line.strip().strip("`").strip()
        if stripped.startswith(prefix):
            return stripped
    return None


def parse_work(text: str | None) -> WorkResult:
    line = _prefixed_line(text, "BOARD-WORK")
    if line is None:
        return WorkResult("lost")
    if m := _WORK["fact"].match(line):
        return WorkResult("fact", m.group(1), m.group(2))
    if _WORK["none"].match(line):
        return WorkResult("none")
    if m := _WORK["partial"].match(line):
        return WorkResult("partial", intent=m.group(1))
    if _WORK["stopped"].match(line):
        return WorkResult("stopped")
    return WorkResult("lost")


def parse_lead(text: str | None) -> LeadResult:
    line = _prefixed_line(text, "BOARD-LEAD")
    if line is None:
        return LeadResult("none")
    if m := _LEAD_RUNNING.match(line):
        return LeadResult("running", free=int(m.group(1)), open=int(m.group(2)))
    if m := _LEAD_PAUSED.match(line):
        return LeadResult("paused", free=int(m.group(1)), open=int(m.group(2)))
    if m := _LEAD_CANDIDATE.match(line):
        return LeadResult("candidate", free=int(m.group(2)), open=int(m.group(3)), ref=m.group(1))
    if m := _LEAD_PLAIN.match(line):
        return LeadResult(m.group(1))  # type: ignore[arg-type]
    if m := _LEAD_REFUSED.match(line):
        return LeadResult("refused", holder=m.group(1), until=m.group(2))
    return LeadResult("none")


def parse_start(text: str | None) -> StartResult:
    line = _prefixed_line(text, "BOARD-START")
    body = text or ""
    if line is None:
        return StartResult("lost", text=body)
    if m := _START_CREATED.match(line):
        return StartResult("created", m.group(1), body)
    if m := _START_PLAIN.match(line):
        return StartResult(m.group(1), text=body)  # type: ignore[arg-type]
    return StartResult("lost", text=body)


def claude_result_text(stdout: str) -> str | None:
    """The `result` text of `claude -p` output, or None if there is none.

    Accepts one JSON object (`--output-format json`) or JSON lines (`--output-format stream-json`),
    where the last `result` line wins and unparsable lines (for example a cut-off last one) are ignored.
    """
    try:
        data = json.loads(stdout)
    except (ValueError, TypeError):
        data = None
    else:
        if not isinstance(data, dict):
            return None
        result = data.get("result")
        return result if isinstance(result, str) else None
    for line in reversed((stdout or "").splitlines()):
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("type") == "result" and isinstance(data.get("result"), str):
            return data["result"]
    return None
