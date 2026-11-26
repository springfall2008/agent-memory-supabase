import re
import unittest
from pathlib import Path

from board_runner.board_file import BoardFile, Measure, WorkerSlot
from board_runner.launch import (
    LEAD_ALLOW,
    SKILL_DIR,
    dir_read_rules,
    lead_argv,
    lead_prompt,
    lead_settings,
    model_args_env,
    new_label,
    oneshot_argv,
    worker_argv,
    worker_env,
)


def board(**overrides) -> BoardFile:
    values = dict(
        path=Path("/b/board.toml"),
        board="b",
        scope="s",
        workspace=Path("/ws"),
        goal="g",
        done_when="d",
        rules="r",
        max_open_intents=4,
        claim_minutes=60,
        max_intents=None,
        measure=None,
        lead_model="opus",
        round_every_minutes=20,
        workers=(WorkerSlot("sonnet", 120),),
        allow=("Edit", "Bash(python3 *)"),
        deny=("Bash(git push*)",),
        max_turns=200,
        max_budget_usd=20,
        worker_timeout_minutes=120,
    )
    values.update(overrides)
    return BoardFile(**values)


def after(argv: list[str], flag: str) -> str:
    return argv[argv.index(flag) + 1]


class WorkerArgvTest(unittest.TestCase):
    def test_anthropic_slot(self):
        argv = worker_argv(board(), WorkerSlot("sonnet", 120), "L")
        self.assertEqual(argv[0], "claude")
        self.assertEqual(after(argv, "-p"), "/blackboard work b label=L runner")
        self.assertEqual(after(argv, "--output-format"), "json")
        self.assertEqual(after(argv, "--permission-mode"), "dontAsk")
        self.assertEqual(after(argv, "--allowedTools"), ",".join(["Edit", "Bash(python3 *)", "mcp__shared-memory__*", *dir_read_rules(SKILL_DIR)]))
        self.assertEqual(after(argv, "--disallowedTools"), "Bash(git push*)")
        self.assertEqual(after(argv, "--max-turns"), "200")
        self.assertEqual(after(argv, "--model"), "sonnet")
        self.assertEqual(after(argv, "--max-budget-usd"), "20")

    def test_no_budget_flag_when_unset(self):
        self.assertNotIn("--max-budget-usd", worker_argv(board(max_budget_usd=None), WorkerSlot("sonnet", 120), "L"))

    def test_ollama_slot(self):
        argv = worker_argv(board(), WorkerSlot("ollama:glm-5.3", 120), "L")
        self.assertEqual(after(argv, "--model"), "glm-5.3")
        self.assertNotIn("--max-budget-usd", argv)


class EnvTest(unittest.TestCase):
    def test_ollama_env_default_url(self):
        args, env = model_args_env("ollama:glm-5.3", {"PATH": "/bin"})
        self.assertEqual(args, ["--model", "glm-5.3"])
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "http://localhost:11434")
        self.assertEqual(env["ANTHROPIC_AUTH_TOKEN"], "ollama")
        self.assertEqual(env["ANTHROPIC_API_KEY"], "")
        self.assertEqual(env["PATH"], "/bin")

    def test_ollama_env_custom_url(self):
        _, env = model_args_env("ollama:x", {"OLLAMA_BASE_URL": "http://host:1"})
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "http://host:1")

    def test_anthropic_env_untouched(self):
        args, env = model_args_env("opus", {"PATH": "/bin"})
        self.assertEqual(args, ["--model", "opus"])
        self.assertNotIn("ANTHROPIC_BASE_URL", env)

    def test_worker_env_disables_background_and_copies(self):
        base = {"PATH": "/bin"}
        env = worker_env(WorkerSlot("sonnet", 1), base)
        self.assertEqual(env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"], "1")
        self.assertNotIn("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", base)
        self.assertEqual(worker_env(WorkerSlot("ollama:x", 1), base)["ANTHROPIC_AUTH_TOKEN"], "ollama")


class LeadTest(unittest.TestCase):
    def test_prompts(self):
        self.assertEqual(lead_prompt("b", "L", measure=False), "/blackboard lead b label=L runner")
        self.assertEqual(lead_prompt("b", "L", measure=True), "/blackboard lead b label=L runner measure")
        self.assertEqual(lead_prompt("b", "L", measure=False, takeover=True), "/blackboard lead b label=L runner takeover")
        measured = lead_prompt("b", "L", measure=True, measured=("ref1", False, Path("/x/m.log")))
        self.assertEqual(measured, "/blackboard lead b label=L runner measure measured ref1 fail output=/x/m.log")
        passed = lead_prompt("b", "L", measure=True, measured=("ref1", True, Path("/x/m.log")))
        self.assertTrue(passed.endswith("measured ref1 pass output=/x/m.log"))

    def test_prompt_never_has_newline(self):
        prompt = lead_prompt("b", "L", measure=True, measured=("a\nb", True, Path("/x/m\n.log")))
        self.assertNotIn("\n", prompt)

    def test_lead_argv(self):
        fresh = lead_argv(board(), "uuid-1", False, Path("/h/lead-settings.json"), "/blackboard lead b label=L runner")
        self.assertEqual(after(fresh, "--session-id"), "uuid-1")
        self.assertNotIn("--resume", fresh)
        self.assertEqual(after(fresh, "--settings"), "/h/lead-settings.json")
        self.assertEqual(after(fresh, "--model"), "opus")
        self.assertEqual(fresh[-1], "/blackboard lead b label=L runner")
        resumed = lead_argv(board(), "uuid-1", True, Path("/h/s.json"), "p")
        self.assertEqual(after(resumed, "--resume"), "uuid-1")
        self.assertNotIn("--session-id", resumed)

    def test_settings_with_and_without_hook(self):
        settings = lead_settings(["/r/board-runner", "hook-stop", "b"], Path("/h"))
        command = settings["hooks"]["Stop"][0]["hooks"][0]["command"]
        self.assertEqual(command, "/r/board-runner hook-stop b")
        self.assertEqual(settings["hooks"]["Stop"][0]["hooks"][0]["type"], "command")
        allow = settings["permissions"]["allow"]
        for rule in LEAD_ALLOW:
            self.assertIn(rule, allow)
        self.assertIn("Read(//h/**)", allow)
        self.assertNotIn("hooks", lead_settings(None, Path("/h")))

    def test_hook_command_is_quoted(self):
        settings = lead_settings(["/path with space/board-runner", "hook-stop", "b"], Path("/h"))
        self.assertEqual(settings["hooks"]["Stop"][0]["hooks"][0]["command"], "'/path with space/board-runner' hook-stop b")

    def test_oneshot(self):
        argv = oneshot_argv(board(), "/blackboard start b from=/b/board.toml", Path("/h/oneshot-settings.json"))
        self.assertEqual(after(argv, "-p"), "/blackboard start b from=/b/board.toml")
        self.assertEqual(after(argv, "--settings"), "/h/oneshot-settings.json")
        self.assertEqual(after(argv, "--output-format"), "json")
        self.assertEqual(after(argv, "--permission-mode"), "dontAsk")
        self.assertEqual(after(argv, "--model"), "opus")


class LabelTest(unittest.TestCase):
    def test_labels(self):
        self.assertRegex(new_label("my-board", "lead"), re.compile(r"^board-my-board-lead-[0-9a-f]{4}$"))
        self.assertRegex(new_label("my-board", "worker"), re.compile(r"^board-my-board-[0-9a-f]{4}$"))



class ReviewFixLaunchTest(unittest.TestCase):
    def test_absolute_read_rules_use_double_slash(self):
        allow = lead_settings(None, Path("/h/b"))["permissions"]["allow"]
        self.assertIn("Read(//h/b/**)", allow)
        self.assertNotIn("Read(/h/b/**)", allow)
        argv = oneshot_argv(board(), "p", Path("/h/oneshot-settings.json"))
        self.assertIn("Read(//b/board.toml)", after(argv, "--allowedTools"))

    def test_workers_may_read_the_skill(self):
        argv = worker_argv(board(), WorkerSlot("sonnet", 1), "L")
        allowed = after(argv, "--allowedTools").split(",")
        for rule in dir_read_rules(SKILL_DIR):
            self.assertIn(rule, allowed)



class SymlinkReadRulesTest(unittest.TestCase):
    def test_symlinked_dir_gets_rules_for_link_and_target(self):
        import tempfile

        from board_runner.launch import dir_read_rules

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "real-skill"
            target.mkdir()
            link = Path(tmp) / "link"
            link.symlink_to(target)
            rules = dir_read_rules(str(link))
            self.assertIn(f"Read(/{link}/**)", rules)
            self.assertIn(f"Read(/{target.resolve()}/**)", rules)

    def test_plain_dir_gets_one_rule(self):
        from board_runner.launch import dir_read_rules

        self.assertEqual(dir_read_rules("/no/such/dir"), ["Read(//no/such/dir/**)"])

    def test_skill_rules_reach_lead_oneshot_and_workers(self):
        from board_runner.launch import SKILL_DIR, dir_read_rules

        expected = dir_read_rules(SKILL_DIR)
        settings = lead_settings(None, Path("/h"))["permissions"]["allow"]
        workers = after(worker_argv(board(), WorkerSlot("sonnet", 1), "L"), "--allowedTools").split(",")
        oneshot = after(oneshot_argv(board(), "p", Path("/s.json")), "--allowedTools").split(",")
        for rule in expected:
            self.assertIn(rule, settings)
            self.assertIn(rule, workers)
            self.assertIn(rule, oneshot)


if __name__ == "__main__":
    unittest.main()
