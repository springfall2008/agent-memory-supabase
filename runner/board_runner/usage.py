"""Raw token counts of the sessions the runner starts, read from their transcripts.

Only token counts: Claude Code's dollar figures are ignored, because they are invented for models it cannot price.
Nothing here raises on a bad transcript; a cut-off or unparsable line is skipped.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# web-api's limits: a row past them is refused, and a refused row is never sent again.
MODELS_MAX = 20
TEXT_MAX = 100


@dataclass(frozen=True)
class Tokens:
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0

    def __add__(self, other: Tokens) -> Tokens:
        return Tokens(
            self.input + other.input,
            self.output + other.output,
            self.cache_read + other.cache_read,
            self.cache_write + other.cache_write,
        )

    def max(self, other: Tokens) -> Tokens:
        return Tokens(
            max(self.input, other.input),
            max(self.output, other.output),
            max(self.cache_read, other.cache_read),
            max(self.cache_write, other.cache_write),
        )

    def body(self) -> dict[str, int]:
        return {"input": self.input, "output": self.output, "cacheRead": self.cache_read, "cacheWrite": self.cache_write}


@dataclass(frozen=True)
class RunUsage:
    tokens: Tokens
    models: dict[str, Tokens] = field(default_factory=dict)
    turns: int | None = None
    duration_ms: int | None = None


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _api_tokens(usage: Any) -> Tokens:
    """The API's `usage` object (snake_case)."""
    if not isinstance(usage, dict):
        return Tokens()
    return Tokens(
        _count(usage.get("input_tokens")),
        _count(usage.get("output_tokens")),
        _count(usage.get("cache_read_input_tokens")),
        _count(usage.get("cache_creation_input_tokens")),
    )


def _model_tokens(usage: Any) -> Tokens:
    """One entry of Claude Code's `modelUsage` (camelCase)."""
    if not isinstance(usage, dict):
        return Tokens()
    return Tokens(
        _count(usage.get("inputTokens")),
        _count(usage.get("outputTokens")),
        _count(usage.get("cacheReadInputTokens")),
        _count(usage.get("cacheCreationInputTokens")),
    )


def _records(text: str) -> list[dict]:
    out = []
    for line in (text or "").splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            out.append(record)
    return out


def _from_result(result: dict) -> RunUsage:
    models = result.get("modelUsage")
    by_model = (
        {name: _model_tokens(u) for name, u in models.items() if isinstance(name, str) and name}
        if isinstance(models, dict)
        else {}
    )
    turns = result.get("num_turns")
    duration = result.get("duration_ms")
    return RunUsage(
        _api_tokens(result.get("usage")),
        by_model,
        turns if isinstance(turns, int) and not isinstance(turns, bool) and turns >= 0 else None,
        duration if isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0 else None,
    )


def _per_message(records: list[dict]) -> dict[str, tuple[str, Tokens]]:
    """Each assistant message once, by id. Claude Code writes one line per content block, each carrying the message's
    usage, so the highest value of each field across those lines is the message's own."""
    seen: dict[str, tuple[str, Tokens]] = {}
    for record in records:
        if record.get("type") != "assistant":
            continue
        message = record.get("message")
        if not isinstance(message, dict) or not isinstance(message.get("id"), str):
            continue
        model = message.get("model") if isinstance(message.get("model"), str) and message.get("model") else "unknown"
        tokens = _api_tokens(message.get("usage"))
        previous = seen.get(message["id"])
        seen[message["id"]] = (model, tokens if previous is None else previous[1].max(tokens))
    return seen


def _summed(messages: dict[str, tuple[str, Tokens]]) -> tuple[Tokens, dict[str, Tokens]]:
    total = Tokens()
    by_model: dict[str, Tokens] = {}
    for model, tokens in messages.values():
        total += tokens
        by_model[model] = by_model.get(model, Tokens()) + tokens
    return total, by_model


def run_usage(stdout: str) -> RunUsage | None:
    """A `claude -p` run's counts, from its `json` or `stream-json` output. The last `result` object wins; without one
    (a run killed or cut off), the per-message sum, with turns and duration unknown. None when nothing is found."""
    try:
        whole = json.loads(stdout)
    except (ValueError, TypeError):
        whole = None
    if isinstance(whole, dict) and whole.get("type") == "result":
        return _from_result(whole)
    records = _records(stdout)
    for record in reversed(records):
        if record.get("type") == "result":
            return _from_result(record)
    messages = _per_message(records)
    if not messages:
        return None
    total, by_model = _summed(messages)
    return RunUsage(total, by_model)


def session_usage(transcript: Path) -> RunUsage:
    """An interactive session's counts: its transcript plus every sub-agent transcript Claude Code keeps beside it.
    Turns are the session's own assistant messages. A missing or unreadable file counts as zero."""

    def read(path: Path) -> dict[str, tuple[str, Tokens]]:
        try:
            return _per_message(_records(path.read_text(errors="replace")))
        except OSError:
            return {}

    transcript = Path(transcript)
    main = read(transcript)
    total, by_model = _summed(main)
    subagents = transcript.with_suffix("") / "subagents"
    try:
        files = sorted(subagents.glob("*.jsonl"))
    except OSError:
        files = []
    for path in files:
        sub_total, sub_models = _summed(read(path))
        total += sub_total
        for model, tokens in sub_models.items():
            by_model[model] = by_model.get(model, Tokens()) + tokens
    return RunUsage(total, by_model, len(main), None)


def usage_row(
    *,
    scope: str,
    board: str,
    run_label: str,
    role: str,
    intent_id: str | None,
    outcome: str | None,
    runner_model: str,
    usage: RunUsage,
    started_at: str | None,
    ended_at: str | None,
) -> dict:
    """The JSON body of web-api's `POST /usage`, trimmed to web-api's limits: the 20 largest models (by all four
    counts) and names cut to 100 characters, so a row is never refused for its shape."""
    largest = sorted(
        usage.models.items(),
        key=lambda kv: kv[1].input + kv[1].output + kv[1].cache_read + kv[1].cache_write,
        reverse=True,
    )[:MODELS_MAX]
    models: dict[str, dict[str, int]] = {}
    for name, tokens in largest:
        key = name[:TEXT_MAX]
        if key in models:
            merged = {k: models[key][k] + v for k, v in tokens.body().items()}
            models[key] = merged
        else:
            models[key] = tokens.body()
    return {
        "scope": scope,
        "board": board,
        "runLabel": run_label,
        "role": role,
        "intentId": intent_id,
        "outcome": outcome,
        "runnerModel": runner_model[:TEXT_MAX],
        "tokens": usage.tokens.body(),
        "turns": usage.turns,
        "durationMs": usage.duration_ms,
        "models": models,
        "startedAt": started_at,
        "endedAt": ended_at,
    }
