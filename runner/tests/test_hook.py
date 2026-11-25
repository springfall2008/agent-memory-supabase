import json
import tempfile
import unittest
from pathlib import Path

from board_runner.hook import hook_stop, last_assistant_text


def now():
    return "2026-11-25T10:00:00Z"


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.events = self.dir / "events.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def transcript(self, records) -> Path:
        path = self.dir / "t.jsonl"
        path.write_text("\n".join(json.dumps(r) for r in records) + "\n")
        return path

    def events_written(self):
        if not self.events.exists():
            return []
        return [json.loads(line) for line in self.events.read_text().splitlines() if line]

    def test_last_assistant_text(self):
        path = self.transcript(
            [
                {"type": "user", "message": {"content": "go"}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "first"}]}},
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "x"}]}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "x\nBOARD-LEAD done"}]}},
                {"type": "user", "message": {"content": [{"type": "tool_result"}]}},
            ]
        )
        self.assertEqual(last_assistant_text(path), "x\nBOARD-LEAD done")

    def test_hook_appends_event(self):
        path = self.transcript([{"type": "assistant", "message": {"content": [{"type": "text", "text": "x\nBOARD-LEAD done"}]}}])
        hook_stop(self.events, json.dumps({"session_id": "s", "transcript_path": str(path)}), now)
        events = self.events_written()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["session_id"], "s")
        self.assertEqual(events[0]["time"], now())
        self.assertTrue(events[0]["text"].endswith("BOARD-LEAD done"))

    def test_text_capped(self):
        path = self.transcript([{"type": "assistant", "message": {"content": [{"type": "text", "text": "a" * 9000 + "\nBOARD-LEAD done"}]}}])
        hook_stop(self.events, json.dumps({"session_id": "s", "transcript_path": str(path)}), now)
        text = self.events_written()[0]["text"]
        self.assertLessEqual(len(text), 4000)
        self.assertTrue(text.endswith("BOARD-LEAD done"))

    def test_garbage_never_raises(self):
        user_only = self.transcript([{"type": "user", "message": {"content": "hi"}}])
        for stdin in (
            "not json",
            "{}",
            "[]",
            json.dumps({"session_id": "s", "transcript_path": str(self.dir / "missing.jsonl")}),
            json.dumps({"session_id": "s", "transcript_path": str(user_only)}),
            json.dumps({"session_id": "s", "transcript_path": 5}),
        ):
            with self.subTest(stdin=stdin):
                hook_stop(self.events, stdin, now)
        for event in self.events_written():
            self.assertEqual(event["text"], "")

    def test_unwritable_events_never_raises(self):
        hook_stop(self.dir / "no-such-dir" / "sub" / "events.jsonl", "{}", now)


    def test_last_assistant_message_preferred(self):
        stdin = json.dumps({"session_id": "s", "last_assistant_message": "x\nBOARD-LEAD done", "transcript_path": str(self.dir / "missing")})
        hook_stop(self.events, stdin, now)
        self.assertTrue(self.events_written()[-1]["text"].endswith("BOARD-LEAD done"))

    def test_non_dict_message_still_appends(self):
        path = self.transcript(
            [
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "BOARD-LEAD done"}]}},
                {"type": "assistant", "message": "oops"},
            ]
        )
        hook_stop(self.events, json.dumps({"session_id": "s", "transcript_path": str(path)}), now)
        self.assertEqual(len(self.events_written()), 1)
        self.assertEqual(self.events_written()[0]["text"], "BOARD-LEAD done")


if __name__ == "__main__":
    unittest.main()
