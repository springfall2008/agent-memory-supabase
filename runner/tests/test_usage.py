import json
import tempfile
import unittest
from pathlib import Path

from board_runner.usage import RunUsage, Tokens, run_usage, session_usage, usage_row


def assistant(msg_id: str, model: str, inp: int, out: int, read: int, write: int, **extra) -> dict:
    usage = {
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_input_tokens": read,
        "cache_creation_input_tokens": write,
    }
    return {"type": "assistant", "message": {"id": msg_id, "model": model, "usage": usage, "content": []}, **extra}


RESULT = {
    "type": "result",
    "subtype": "success",
    "num_turns": 6,
    "duration_ms": 12924,
    "total_cost_usd": 6.09,
    "result": "done\nBOARD-WORK none",
    "usage": {
        "input_tokens": 8,
        "output_tokens": 987,
        "cache_read_input_tokens": 197829,
        "cache_creation_input_tokens": 39470,
    },
    "modelUsage": {
        "glm-5.3:cloud": {
            "inputTokens": 8,
            "outputTokens": 987,
            "cacheReadInputTokens": 197829,
            "cacheCreationInputTokens": 39470,
            "costUSD": 6.09,
            "costBasis": "unknown",
        }
    },
}


def lines(*records) -> str:
    return "".join(json.dumps(r) + "\n" for r in records)


class RunUsageTest(unittest.TestCase):
    def test_result_line_gives_the_totals_models_turns_and_duration(self):
        text = lines({"type": "system", "subtype": "init"}, assistant("m1", "glm-5.3:cloud", 1, 1, 1, 1), RESULT)
        u = run_usage(text)
        self.assertEqual(u.tokens, Tokens(input=8, output=987, cache_read=197829, cache_write=39470))
        self.assertEqual(u.models, {"glm-5.3:cloud": Tokens(8, 987, 197829, 39470)})
        self.assertEqual((u.turns, u.duration_ms), (6, 12924))

    def test_without_a_result_each_message_counts_once_and_a_cut_line_is_ignored(self):
        text = lines(
            assistant("m1", "claude-haiku-5-5", 2, 1, 100, 50),
            assistant("m1", "claude-haiku-5-5", 2, 3, 100, 50),
            assistant("m1", "claude-haiku-5-5", 2, 3, 100, 50),
            {"type": "user"},
            assistant("m2", "claude-haiku-5-5", 4, 7, 200, 0),
        ) + '{"type": "assistant", "message": {"id": "m3", "usa'
        u = run_usage(text)
        self.assertEqual(u.tokens, Tokens(input=6, output=10, cache_read=300, cache_write=50))
        self.assertEqual(u.models, {"claude-haiku-5-5": Tokens(6, 10, 300, 50)})
        self.assertEqual((u.turns, u.duration_ms), (None, None))

    def test_old_single_object_output(self):
        self.assertEqual(run_usage(json.dumps(RESULT)).tokens.output, 987)

    def test_dollars_are_never_read(self):
        u = run_usage(lines(RESULT))
        self.assertFalse(any("cost" in f for f in RunUsage.__dataclass_fields__))
        self.assertFalse(any("cost" in f for f in Tokens.__dataclass_fields__))
        self.assertEqual(u.tokens.input, 8)

    def test_nothing_found_is_none(self):
        self.assertIsNone(run_usage(""))
        self.assertIsNone(run_usage(lines({"type": "system", "subtype": "init"})))
        self.assertIsNone(run_usage("not json"))


class SessionUsageTest(unittest.TestCase):
    def test_sums_the_session_and_its_subagents(self):
        with tempfile.TemporaryDirectory() as d:
            main = Path(d) / "abc.jsonl"
            main.write_text(
                lines(
                    assistant("a1", "claude-opus-5-5", 1, 10, 100, 1000),
                    assistant("a1", "claude-opus-5-5", 1, 10, 100, 1000),
                    assistant("a2", "claude-opus-5-5", 2, 20, 200, 0),
                )
            )
            sub = Path(d) / "abc" / "subagents"
            sub.mkdir(parents=True)
            (sub / "agent-x.jsonl").write_text(lines(assistant("s1", "claude-fable-5-2", 5, 50, 500, 5)))
            u = session_usage(main)
        self.assertEqual(u.tokens, Tokens(input=8, output=80, cache_read=800, cache_write=1005))
        self.assertEqual(
            u.models, {"claude-opus-5-5": Tokens(3, 30, 300, 1000), "claude-fable-5-2": Tokens(5, 50, 500, 5)}
        )
        self.assertEqual((u.turns, u.duration_ms), (2, None))

    def test_a_missing_transcript_counts_zero(self):
        u = session_usage(Path("/nonexistent/nothing.jsonl"))
        self.assertEqual(u.tokens, Tokens())
        self.assertEqual(u.models, {})


class UsageRowTest(unittest.TestCase):
    def test_row_has_exactly_the_web_api_keys(self):
        u = RunUsage(Tokens(1, 2, 3, 4), {"opus": Tokens(1, 2, 3, 4)}, 5, 600)
        row = usage_row(
            scope="s",
            board="b",
            run_label="board-b-0001",
            role="worker",
            intent_id="i",
            outcome="fact confirmed",
            runner_model="opus",
            usage=u,
            started_at="2026-11-27T08:00:00Z",
            ended_at=None,
        )
        self.assertEqual(json.loads(json.dumps(row)), row)
        self.assertEqual(
            set(row),
            {
                "scope", "board", "runLabel", "role", "intentId", "outcome", "runnerModel", "tokens", "turns",
                "durationMs", "models", "startedAt", "endedAt",
            },
        )
        self.assertEqual(row["tokens"], {"input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4})
        self.assertEqual(row["models"], {"opus": {"input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4}})
        self.assertEqual((row["turns"], row["durationMs"], row["endedAt"]), (5, 600, None))

    def test_row_keeps_the_20_largest_models_and_cuts_long_names(self):
        models = {f"m{i:02d}": Tokens(input=i) for i in range(25)}
        models["x" * 150] = Tokens(input=1000)
        row = usage_row(
            scope="s", board="b", run_label="l", role="worker", intent_id=None, outcome=None, runner_model="r" * 150,
            usage=RunUsage(Tokens(), models), started_at=None, ended_at=None,
        )
        self.assertEqual(len(row["models"]), 20)
        self.assertIn("x" * 100, row["models"])
        self.assertNotIn("m00", row["models"])
        self.assertEqual(len(row["runnerModel"]), 100)


if __name__ == "__main__":
    unittest.main()
