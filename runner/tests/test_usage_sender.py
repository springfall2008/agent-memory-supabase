import json
import tempfile
import unittest
from pathlib import Path

from board_runner.usage_sender import QUEUE_MAX, UsageQueue, usage_config


def row(label: str, n: int = 1) -> dict:
    return {"scope": "s", "board": "b", "runLabel": label, "tokens": {"input": n}}


class FakePost:
    def __init__(self, *statuses: int):
        self.statuses = list(statuses)
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, path: str, body: dict) -> int:
        self.calls.append((path, body))
        return self.statuses.pop(0) if self.statuses else 200


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "usage-pending.jsonl"
        self.logs: list[tuple[str, bool]] = []

    def tearDown(self):
        self.tmp.cleanup()

    def queue(self, post) -> UsageQueue:
        return UsageQueue(self.path, post, lambda: 0.0, lambda m, warn=False: self.logs.append((m, warn)))

    def test_a_sent_row_leaves_the_file(self):
        post = FakePost(200)
        q = self.queue(post)
        q.add(row("a"))
        q.flush(0)
        self.assertEqual(post.calls, [("/usage", row("a"))])
        self.assertEqual(q.pending(), 0)
        self.assertEqual(self.path.read_text(), "")

    def test_a_row_that_can_never_succeed_is_dropped_with_one_log_line(self):
        for status in (400, 413, 422):
            post = FakePost(status)
            q = self.queue(post)
            q.add(row(f"r{status}"))
            q.flush(0)
            self.assertEqual(q.pending(), 0, status)
        self.assertEqual(len([m for m, _ in self.logs if "dropped" in m]), 3)

    def test_other_failures_keep_the_row_and_back_off(self):
        for status in (401, 403, 404, 500, 0):
            self.path.unlink(missing_ok=True)
            post = FakePost(status, status, status, status)
            q = self.queue(post)
            q.add(row("a"))
            q.flush(0)
            self.assertEqual(q.pending(), 1, status)
            q.flush(4)  # not due yet: the first wait is 5 s
            self.assertEqual(len(post.calls), 1, status)
            q.flush(5)
            self.assertEqual(len(post.calls), 2, status)
            q.flush(14)  # then 10 s
            self.assertEqual(len(post.calls), 2, status)
            q.flush(15)
            self.assertEqual(len(post.calls), 3, status)

    def test_backoff_is_capped_at_five_minutes(self):
        post = FakePost(*([500] * 20))
        q = self.queue(post)
        q.add(row("a"))
        t = 0.0
        q.flush(t)
        for _ in range(12):
            t += 300
            q.flush(t)
        self.assertEqual(len(post.calls), 13)

    def test_a_success_resets_the_backoff_and_sends_the_rest_in_order(self):
        post = FakePost(404)
        q = self.queue(post)
        q.add(row("a"))
        q.add(row("b"))
        q.flush(0)
        self.assertEqual([c[1]["runLabel"] for c in post.calls], ["a"])
        q.flush(5)
        self.assertEqual([c[1]["runLabel"] for c in post.calls], ["a", "a", "b"])
        self.assertEqual(q.pending(), 0)
        q.add(row("c"))
        q.flush(5)
        self.assertEqual(post.calls[-1][1]["runLabel"], "c")

    def test_the_same_failure_is_logged_once(self):
        post = FakePost(*([404] * 5))
        q = self.queue(post)
        q.add(row("a"))
        for t in (0, 5, 15, 35, 75):
            q.flush(t)
        self.assertEqual(len([m for m, _ in self.logs if "404" in m]), 1)

    def test_a_row_with_the_same_key_replaces_the_pending_one(self):
        q = self.queue(FakePost(500))
        q.add(row("lead", 1))
        q.add(row("lead", 2))
        self.assertEqual(q.pending(), 1)
        self.assertEqual(json.loads(self.path.read_text().splitlines()[0])["tokens"], {"input": 2})

    def test_the_queue_keeps_the_newest_ten_thousand(self):
        q = self.queue(FakePost())
        for i in range(QUEUE_MAX + 1):
            q.add(row(f"r{i}"))
        self.assertEqual(QUEUE_MAX, 10_000)
        self.assertEqual(q.pending(), QUEUE_MAX)
        self.assertEqual(json.loads(self.path.read_text().splitlines()[0])["runLabel"], "r1")
        self.assertTrue(any(warn and "oldest" in m for m, warn in self.logs))

    def test_a_new_queue_sees_what_an_earlier_one_left_and_skips_a_corrupt_line(self):
        self.queue(FakePost(500)).add(row("a"))
        with self.path.open("a") as f:
            f.write("{not json\n")
        post = FakePost(200)
        q = self.queue(post)
        self.assertEqual(q.pending(), 1)
        q.flush(0)
        self.assertEqual(post.calls, [("/usage", row("a"))])


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "x.env"

    def tearDown(self):
        self.tmp.cleanup()

    def test_env_wins_over_the_file(self):
        self.file.write_text("AGENT_MEMORY_TOKEN=from-file\nWEB_API_URL=https://file.example/functions/v1/web-api\n")
        env = {"AGENT_MEMORY_TOKEN": "from-env", "WEB_API_URL": "https://env.example/functions/v1/web-api/"}
        self.assertEqual(usage_config(env, self.file), ("https://env.example/functions/v1/web-api", "from-env"))

    def test_agent_memory_url_becomes_web_api(self):
        env = {"AGENT_MEMORY_TOKEN": "t", "AGENT_MEMORY_URL": "https://h.example/functions/v1/agent-memory"}
        self.assertEqual(usage_config(env, None), ("https://h.example/functions/v1/web-api", "t"))

    def test_the_file_takes_quotes_comments_and_export(self):
        self.file.write_text(
            "# a comment\nexport AGENT_MEMORY_TOKEN=\"quoted\"\nAGENT_MEMORY_URL='https://h.example/functions/v1/agent-memory'\n"
        )
        self.assertEqual(usage_config({}, self.file), ("https://h.example/functions/v1/web-api", "quoted"))

    def test_no_token_or_no_url_is_none(self):
        self.assertIsNone(usage_config({"WEB_API_URL": "https://h.example/web-api"}, None))
        self.assertIsNone(usage_config({"AGENT_MEMORY_TOKEN": "t"}, None))
        self.assertIsNone(usage_config({"AGENT_MEMORY_TOKEN": "t", "AGENT_MEMORY_URL": "https://h.example/other"}, None))
        self.assertIsNone(usage_config({}, Path("/nonexistent/x.env")))


if __name__ == "__main__":
    unittest.main()
