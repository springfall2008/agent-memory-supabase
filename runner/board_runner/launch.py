"""Command lines and environments for the lead, workers and one-shot runs."""

from __future__ import annotations

import os
import secrets
import shlex
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

from .board_file import BoardFile, WorkerSlot

OLLAMA_PREFIX = "ollama:"
DEFAULT_OLLAMA_URL = "http://localhost:11434"
MEMORY_TOOLS = "mcp__shared-memory__*"
SKILL_DIR = "~/.claude/skills/blackboard"
LEAD_ALLOW = [MEMORY_TOOLS, "Bash(date*)", "Bash(openssl rand*)"]


def read_rule(path: Path | str) -> str:
    """A Read permission rule for a path. An absolute path needs a leading // in Claude Code's rule syntax."""
    text = str(path)
    return f"Read(/{text})" if text.startswith("/") else f"Read({text})"


def dir_read_rules(path: Path | str) -> list[str]:
    """Read rules for a directory tree. Claude Code checks a path reached through a symlink against both the link and
    its target, so a symlinked directory (the usual skill install) needs a rule for each."""
    expanded = Path(path).expanduser()
    rules = [read_rule(f"{expanded}/**")]
    resolved = expanded.resolve()
    if resolved != expanded:
        rules.append(read_rule(f"{resolved}/**"))
    return rules


def lead_allow() -> list[str]:
    return [*LEAD_ALLOW, *dir_read_rules(SKILL_DIR)]


def new_label(board: str, role: Literal["lead", "worker"]) -> str:
    hex4 = secrets.token_hex(2)
    return f"board-{board}-lead-{hex4}" if role == "lead" else f"board-{board}-{hex4}"


def is_ollama(model: str) -> bool:
    return model.startswith(OLLAMA_PREFIX)


def model_args_env(model: str, base_env: Mapping[str, str]) -> tuple[list[str], dict[str, str]]:
    """The --model args for a model, and a copy of base_env with Ollama's overrides when it is an Ollama model."""
    env = dict(base_env)
    if not is_ollama(model):
        return ["--model", model], env
    env["ANTHROPIC_BASE_URL"] = base_env.get("OLLAMA_BASE_URL", DEFAULT_OLLAMA_URL)
    env["ANTHROPIC_AUTH_TOKEN"] = "ollama"
    env["ANTHROPIC_API_KEY"] = ""
    return ["--model", model[len(OLLAMA_PREFIX):]], env


def _budget_args(bf: BoardFile, model: str) -> list[str]:
    if bf.max_budget_usd is None or is_ollama(model):
        return []
    return ["--max-budget-usd", f"{bf.max_budget_usd:g}"]


def worker_argv(bf: BoardFile, slot: WorkerSlot, label: str) -> list[str]:
    model_args, _ = model_args_env(slot.model, {})
    allow = list(bf.allow)
    for rule in (MEMORY_TOOLS, *dir_read_rules(SKILL_DIR)):
        if rule not in allow:
            allow.append(rule)
    return [
        "claude",
        "-p",
        f"/blackboard work {bf.board} label={label} runner",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        ",".join(allow),
        "--disallowedTools",
        ",".join(bf.deny),
        "--max-turns",
        str(bf.max_turns),
        *model_args,
        *_budget_args(bf, slot.model),
    ]


def worker_env(slot: WorkerSlot, base_env: Mapping[str, str] | None = None) -> dict[str, str]:
    _, env = model_args_env(slot.model, os.environ if base_env is None else base_env)
    # A `claude -p` run ends at its last message, so anything it backgrounds is lost (learnt in the triage daemon).
    env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] = "1"
    return env


def _one_line(value: str) -> str:
    return " ".join(str(value).split())


def lead_prompt(
    board: str,
    label: str,
    *,
    measure: bool,
    takeover: bool = False,
    measured: tuple[str, bool, Path] | None = None,
) -> str:
    parts = [f"/blackboard lead {board} label={label} runner"]
    if measure:
        parts.append("measure")
    if takeover:
        parts.append("takeover")
    if measured is not None:
        ref, passed, output = measured
        parts.append(f"measured {_one_line(ref).replace(' ', '_')} {'pass' if passed else 'fail'} output={_one_line(str(output))}")
    return _one_line(" ".join(parts))


def lead_argv(bf: BoardFile, session_id: str, resume: bool, settings_path: Path, first_prompt: str) -> list[str]:
    model_args, _ = model_args_env(bf.lead_model, {})
    session = ["--resume", session_id] if resume else ["--session-id", session_id]
    return ["claude", *session, *model_args, "--settings", str(settings_path), first_prompt]


def lead_env(bf: BoardFile, base_env: Mapping[str, str] | None = None) -> dict[str, str]:
    _, env = model_args_env(bf.lead_model, os.environ if base_env is None else base_env)
    return env


def lead_settings(hook_argv: list[str] | None, runner_home: Path) -> dict:
    """Settings for the lead (with the Stop hook) or for one-shot runs (hook_argv None: no hooks at all)."""
    settings: dict = {"permissions": {"allow": [*lead_allow(), *dir_read_rules(runner_home)]}}
    if hook_argv is not None:
        settings["hooks"] = {"Stop": [{"hooks": [{"type": "command", "command": shlex.join(hook_argv)}]}]}
    return settings


def oneshot_argv(bf: BoardFile, prompt: str, settings_path: Path) -> list[str]:
    model_args, _ = model_args_env(bf.lead_model, {})
    return [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--settings",
        str(settings_path),
        "--allowedTools",
        ",".join([*lead_allow(), read_rule(bf.path)]),
        "--max-turns",
        str(bf.max_turns),
        *model_args,
    ]
