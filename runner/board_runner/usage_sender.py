"""Send usage rows to web-api, durably: every row is written to a pending file first and leaves it only once accepted.

This is the runner's only network call and its only write to shared memory; it never reads the board. Sending never
raises and never blocks for longer than the HTTP timeout.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from pathlib import Path

QUEUE_MAX = 10_000
# Rows sent per loop tick: a backlog after an outage drains over a few ticks rather than stalling scheduling.
FLUSH_ROWS = 10
FIRST_DELAY = 5.0
MAX_DELAY = 300.0
# A row refused for its own content can never succeed: drop it. Anything else (a revoked token, a scope the token
# cannot write, a web-api older than the runner, the network) may clear up, so the row waits.
NEVER = {400, 413, 422}

Post = Callable[[str, dict], int]
Log = Callable[..., None]


def _key(row: dict) -> tuple:
    return (row.get("scope"), row.get("board"), row.get("runLabel"))


class UsageQueue:
    def __init__(self, path: Path, post: Post, clock: Callable[[], float], log: Log):
        self.path = Path(path)
        self.post = post
        self.clock = clock
        self.log = log
        self.rows: list[dict] = self._load()
        self.delay = 0.0
        self.next_at = 0.0
        self.failing: str | None = None

    def _load(self) -> list[dict]:
        try:
            text = self.path.read_text()
        except OSError:
            return []
        rows = []
        for line in text.splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict):
                rows.append(row)
        return rows

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text("".join(json.dumps(r) + "\n" for r in self.rows))
            os.replace(tmp, self.path)
        except OSError as exc:
            self.log(f"cannot write the usage queue {self.path}: {exc}", warn=True)

    def pending(self) -> int:
        return len(self.rows)

    def add(self, row: dict) -> None:
        """Queue a row; a pending row with the same scope, board and run label is replaced by it."""
        key = _key(row)
        for i, old in enumerate(self.rows):
            if _key(old) == key:
                self.rows[i] = row
                self._save()
                return
        self.rows.append(row)
        if len(self.rows) > QUEUE_MAX:
            dropped = len(self.rows) - QUEUE_MAX
            del self.rows[:dropped]
            self.log(f"usage queue is full: dropped the oldest {dropped} row(s)", warn=True)
            self._save()
            return
        # A new row only appends, so a long queue is not rewritten on every add.
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a") as handle:
                handle.write(json.dumps(row) + "\n")
        except OSError as exc:
            self.log(f"cannot write the usage queue {self.path}: {exc}", warn=True)

    def flush(self, now: float) -> None:
        """Send up to FLUSH_ROWS due rows in order, stopping at the first that fails for a reason that may clear up."""
        if not self.rows or now < self.next_at:
            return
        changed = False
        sent = 0
        while self.rows and sent < FLUSH_ROWS:
            sent += 1
            row = self.rows[0]
            try:
                status = self.post("/usage", row)
            except Exception:  # noqa: BLE001 - sending must never stop the runner
                status = 0
            if 200 <= status < 300:
                self.rows.pop(0)
                changed = True
                if self.failing is not None:
                    self.log("usage rows are being accepted again")
                    self.failing = None
                self.delay = 0.0
                self.next_at = 0.0
                continue
            if status in NEVER:
                self.rows.pop(0)
                changed = True
                self.log(f"usage row {row.get('runLabel')} dropped: web-api refused it (HTTP {status})", warn=True)
                continue
            reason = "network error" if status == 0 else f"HTTP {status}"
            if self.failing != reason:
                self.log(f"usage not sent ({reason}); {len(self.rows)} row(s) queued, retrying", warn=True)
                self.failing = reason
            self.delay = FIRST_DELAY if self.delay == 0 else min(self.delay * 2, MAX_DELAY)
            self.next_at = now + self.delay
            break
        if changed:
            self._save()


def _env_file(path: Path | None) -> dict[str, str]:
    if path is None:
        return {}
    try:
        text = Path(path).read_text()
    except OSError:
        return {}
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def usage_config(env: Mapping[str, str], env_file: Path | None) -> tuple[str, str] | None:
    """`(web-api base URL, token)` from the environment, else from `env_file`; None when either is missing."""
    values = {**_env_file(env_file), **{k: v for k, v in env.items() if v}}
    token = values.get("AGENT_MEMORY_TOKEN")
    url = (values.get("WEB_API_URL") or "").rstrip("/")
    if not url:
        memory = (values.get("AGENT_MEMORY_URL") or "").rstrip("/")
        head, _, last = memory.rpartition("/")
        url = f"{head}/web-api" if head and last == "agent-memory" else ""
    if not token or not url:
        return None
    return url, token


def http_call(base_url: str, token: str, timeout: float = 5.0) -> Callable[[str, dict], tuple[int, dict | None]]:
    """A `call(path, body) -> (status, JSON reply)` for web-api; status 0 means no HTTP answer at all."""

    def call(path: str, body: dict) -> tuple[int, dict | None]:
        request = urllib.request.Request(
            base_url + path,
            data=json.dumps(body).encode(),
            method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, _json_reply(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, _json_reply(exc.read())
        except (urllib.error.URLError, OSError, ValueError):
            return 0, None

    return call


def _json_reply(raw: bytes) -> dict | None:
    try:
        reply = json.loads(raw)
    except ValueError:
        return None
    return reply if isinstance(reply, dict) else None


def http_post(base_url: str, token: str, timeout: float = 5.0) -> Post:
    """A `post(path, body) -> status` for web-api; 0 means the request never got an HTTP answer."""
    call = http_call(base_url, token, timeout)
    return lambda path, body: call(path, body)[0]
