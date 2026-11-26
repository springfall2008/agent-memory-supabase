"""Load and validate a board file (TOML).

Every key is checked: an unknown key is an error naming it, so a typo never silently falls back to a default.
"""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PUSH_DENY = "Bash(git push*)"
_BOARD_NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


class BoardFileError(ValueError):
    pass


@dataclass(frozen=True)
class WorkerSlot:
    model: str
    timeout_minutes: int


@dataclass(frozen=True)
class Measure:
    command: str
    pass_exit_code: int
    timeout_minutes: int
    exclusive: bool


@dataclass(frozen=True)
class BoardFile:
    path: Path
    board: str
    scope: str
    workspace: Path
    goal: str
    done_when: str
    rules: str
    max_open_intents: int
    claim_minutes: int
    max_intents: int | None
    measure: Measure | None
    lead_model: str
    round_every_minutes: int
    workers: tuple[WorkerSlot, ...]
    allow: tuple[str, ...]
    deny: tuple[str, ...]
    max_turns: int
    max_budget_usd: float | None
    worker_timeout_minutes: int


_TOP_KEYS = {
    "board", "scope", "workspace", "goal", "done_when", "rules",
    "max_open_intents", "claim_minutes", "max_intents", "measure", "lead", "worker", "permissions",
}
_MEASURE_KEYS = {"command", "pass_exit_code", "timeout_minutes", "exclusive"}
_LEAD_KEYS = {"model", "round_every_minutes"}
_WORKER_KEYS = {"model", "timeout_minutes"}
_PERMISSION_KEYS = {"allow", "deny", "max_turns", "max_budget_usd", "worker_timeout_minutes"}


def _check_keys(table: dict[str, Any], allowed: set[str], where: str) -> None:
    for key in table:
        if key not in allowed:
            raise BoardFileError(f"unknown key {where}{key}")


def _table(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key, {})
    if not isinstance(value, dict):
        raise BoardFileError(f"{key} must be a table")
    return value


def _text(data: dict[str, Any], key: str, where: str = "") -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise BoardFileError(f"{where}{key} is required and must be a non-empty string")
    return value


def _int(data: dict[str, Any], key: str, default: int | None, where: str = "", maximum: int | None = None) -> int | None:
    if key not in data:
        return default
    value = data[key]
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or (maximum is not None and value > maximum):
        bound = f"1 to {maximum}" if maximum is not None else "at least 1"
        raise BoardFileError(f"{where}{key} must be an integer, {bound}")
    return value


def _model(data: dict[str, Any], key: str, default: str | None, where: str) -> str:
    if key not in data and default is not None:
        return default
    model = _text(data, key, where)
    if model.startswith("ollama:") and not model[len("ollama:"):].strip():
        raise BoardFileError(f"{where}{key} needs a model name after 'ollama:'")
    return model


def _strings(data: dict[str, Any], key: str, where: str) -> tuple[str, ...]:
    value = data.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise BoardFileError(f"{where}{key} must be a list of non-empty strings")
    return tuple(value)


def load_board_file(path: Path) -> BoardFile:
    path = Path(path)
    try:
        data = tomllib.loads(path.read_text())
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise BoardFileError(f"cannot read board file {path}: {exc}") from exc

    _check_keys(data, _TOP_KEYS, "")
    board = _text(data, "board")
    if not _BOARD_NAME.match(board):
        raise BoardFileError("board must be lower-case kebab, for example release-notes")
    workspace = Path(_text(data, "workspace")).expanduser()
    if not workspace.is_dir():
        raise BoardFileError(f"workspace {workspace} is not an existing directory")

    claim_minutes = _int(data, "claim_minutes", 60)
    max_intents = _int(data, "max_intents", None)

    measure = None
    if "measure" in data:
        table = _table(data, "measure")
        _check_keys(table, _MEASURE_KEYS, "measure.")
        exit_code = table.get("pass_exit_code", 0)
        if isinstance(exit_code, bool) or not isinstance(exit_code, int):
            raise BoardFileError("measure.pass_exit_code must be an integer")
        exclusive = table.get("exclusive", False)
        if not isinstance(exclusive, bool):
            raise BoardFileError("measure.exclusive must be true or false")
        measure = Measure(_text(table, "command", "measure."), exit_code, _int(table, "timeout_minutes", 30, "measure."), exclusive)

    lead = _table(data, "lead")
    _check_keys(lead, _LEAD_KEYS, "lead.")
    lead_model = _model(lead, "model", "opus", "lead.")
    round_every = _int(lead, "round_every_minutes", 20, "lead.", maximum=29)

    permissions = _table(data, "permissions")
    _check_keys(permissions, _PERMISSION_KEYS, "permissions.")
    worker_timeout = _int(permissions, "worker_timeout_minutes", 2 * claim_minutes, "permissions.")
    budget = permissions.get("max_budget_usd")
    if budget is not None and (isinstance(budget, bool) or not isinstance(budget, (int, float)) or budget <= 0):
        raise BoardFileError("permissions.max_budget_usd must be a positive number")
    deny = _strings(permissions, "deny", "permissions.")
    if PUSH_DENY not in deny:
        deny = (PUSH_DENY,) + deny

    raw_workers = data.get("worker")
    if not isinstance(raw_workers, list) or not raw_workers:
        raise BoardFileError("at least one [[worker]] is required")
    workers = []
    for index, slot in enumerate(raw_workers):
        if not isinstance(slot, dict):
            raise BoardFileError(f"worker[{index}] must be a table")
        where = f"worker[{index}]."
        _check_keys(slot, _WORKER_KEYS, where)
        workers.append(WorkerSlot(_model(slot, "model", None, where), _int(slot, "timeout_minutes", worker_timeout, where)))

    return BoardFile(
        path=path.resolve(),
        board=board,
        scope=_text(data, "scope"),
        workspace=workspace.resolve(),
        goal=_text(data, "goal"),
        done_when=_text(data, "done_when"),
        rules=_text(data, "rules"),
        max_open_intents=_int(data, "max_open_intents", 4),
        claim_minutes=claim_minutes,
        max_intents=max_intents,
        measure=measure,
        lead_model=lead_model,
        round_every_minutes=round_every,
        workers=tuple(workers),
        allow=_strings(permissions, "allow", "permissions."),
        deny=deny,
        max_turns=_int(permissions, "max_turns", 200, "permissions."),
        max_budget_usd=budget,
        worker_timeout_minutes=worker_timeout,
    )
