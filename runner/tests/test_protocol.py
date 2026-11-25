import unittest

from board_runner.protocol import (
    LeadResult,
    StartResult,
    WorkResult,
    claude_result_text,
    parse_lead,
    parse_start,
    parse_work,
)


class ParseWorkTest(unittest.TestCase):
    def test_fact_line_after_other_text(self):
        text = "did it\n(label: x)\nBOARD-WORK fact confirmed intent=abc"
        self.assertEqual(parse_work(text), WorkResult("fact", "confirmed", "abc"))

    def test_none_partial_stopped(self):
        self.assertEqual(parse_work("BOARD-WORK none"), WorkResult("none"))
        self.assertEqual(parse_work("BOARD-WORK partial intent=abc"), WorkResult("partial", intent="abc"))
        self.assertEqual(parse_work("BOARD-WORK stopped"), WorkResult("stopped"))

    def test_every_verdict(self):
        for verdict in ("confirmed", "refuted", "inconclusive"):
            self.assertEqual(parse_work(f"BOARD-WORK fact {verdict} intent=i1"), WorkResult("fact", verdict, "i1"))

    def test_trailing_sentence_still_parses(self):
        self.assertEqual(parse_work("BOARD-WORK none\nThat is all."), WorkResult("none"))

    def test_lost(self):
        for text in (
            None,
            "",
            "no line",
            "BOARD-WORK fact",
            "BOARD-WORK fact maybe intent=x",
            "BOARD-WORK banana",
            "BOARD-WORK partial",
        ):
            with self.subTest(text=text):
                self.assertEqual(parse_work(text), WorkResult("lost"))


class ParseLeadTest(unittest.TestCase):
    def test_running(self):
        self.assertEqual(parse_lead("round done\nBOARD-LEAD running free=2 open=3"), LeadResult("running", free=2, open=3))

    def test_candidate(self):
        self.assertEqual(
            parse_lead("BOARD-LEAD candidate board/x/1a2b free=0 open=1"),
            LeadResult("candidate", free=0, open=1, ref="board/x/1a2b"),
        )

    def test_terminal_kinds(self):
        for kind in ("done", "stopped", "outgrown"):
            self.assertEqual(parse_lead(f"BOARD-LEAD {kind}"), LeadResult(kind))

    def test_refused(self):
        self.assertEqual(
            parse_lead("BOARD-LEAD refused me 2026-11-25T10:00:00Z"),
            LeadResult("refused", holder="me", until="2026-11-25T10:00:00Z"),
        )

    def test_none(self):
        for text in (None, "", "asked a question", "BOARD-LEAD running free=x", "BOARD-LEAD candidate free=1 open=1"):
            with self.subTest(text=text):
                self.assertEqual(parse_lead(text), LeadResult("none"))


class ParseStartTest(unittest.TestCase):
    def test_exists_keeps_text(self):
        result = parse_start("diff: rules differ\nBOARD-START exists")
        self.assertEqual(result.kind, "exists")
        self.assertIn("rules differ", result.text)

    def test_created(self):
        self.assertEqual(parse_start("BOARD-START created g1"), StartResult("created", "g1", "BOARD-START created g1"))

    def test_resumed_and_not_running(self):
        self.assertEqual(parse_start("BOARD-START resumed").kind, "resumed")
        self.assertEqual(parse_start("BOARD-START not-running").kind, "not-running")

    def test_lost(self):
        for text in (None, "", "BOARD-START created", "BOARD-START maybe"):
            with self.subTest(text=text):
                self.assertEqual(parse_start(text).kind, "lost")


class ClaudeResultTextTest(unittest.TestCase):
    def test_result_field(self):
        self.assertEqual(claude_result_text('{"type":"result","result":"hi","is_error":false}'), "hi")

    def test_unparsable(self):
        for stdout in ("", "{", "[]", '{"is_error":true}', '{"result":5}', "null"):
            with self.subTest(stdout=stdout):
                self.assertIsNone(claude_result_text(stdout))


if __name__ == "__main__":
    unittest.main()
