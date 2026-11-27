import tempfile
import textwrap
import unittest
from pathlib import Path

from board_runner.board_file import BoardFileError, Measure, WorkerSlot, load_board_file

MINIMAL = """
board = "toy-board"
scope = "agent-memory-tool"
workspace = "{workspace}"
goal = "Find n."
done_when = "A fact confirms n."
rules = "Compute only."

[[worker]]
model = "haiku"
"""

FULL = """
board = "predbat-optimiser"
scope = "predbat-devs"
workspace = "{workspace}"
goal = "Make the planning optimiser faster with no plan changes."
done_when = "At least 40% faster than main."
rules = "How to work: ..."
max_open_intents = 4
claim_minutes = 90
max_intents = 20

[measure]
command = "./tools/board-measure.sh"
pass_exit_code = 0
timeout_minutes = 30
exclusive = true

[lead]
model = "opus"
round_every_minutes = 20
ideas_model = "fable"

[[worker]]
model = "opus"
timeout_minutes = 120
[[worker]]
model = "sonnet"
[[worker]]
model = "ollama:glm-5.3"

[permissions]
allow = ["Bash(git worktree*)", "Edit"]
deny = ["Bash(git push*)", "Bash(rm -rf*)"]
max_turns = 200
max_budget_usd = 20
worker_timeout_minutes = 180
"""


class BoardFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.workspace = self.dir / "ws"
        self.workspace.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, text: str, **subs) -> Path:
        path = self.dir / "board.toml"
        path.write_text(textwrap.dedent(text).format(workspace=self.workspace, **subs))
        return path

    def minimal(self, extra: str = "", replace: tuple[str, str] | None = None) -> Path:
        text = MINIMAL
        if replace:
            text = text.replace(*replace)
        return self.write(text + extra)

    def assertRejects(self, path: Path, key: str):
        with self.assertRaises(BoardFileError) as ctx:
            load_board_file(path)
        self.assertIn(key, str(ctx.exception))

    def test_full_example(self):
        bf = load_board_file(self.write(FULL))
        self.assertEqual(bf.board, "predbat-optimiser")
        self.assertEqual(bf.scope, "predbat-devs")
        self.assertEqual(bf.workspace, self.workspace.resolve())
        self.assertEqual(bf.max_open_intents, 4)
        self.assertEqual(bf.claim_minutes, 90)
        self.assertEqual(bf.max_intents, 20)
        self.assertEqual(bf.measure, Measure("./tools/board-measure.sh", 0, 30, True))
        self.assertEqual(bf.lead_model, "opus")
        self.assertEqual(bf.round_every_minutes, 20)
        self.assertEqual(bf.ideas_model, "fable")
        self.assertEqual(
            bf.workers,
            (WorkerSlot("opus", 120), WorkerSlot("sonnet", 180), WorkerSlot("ollama:glm-5.3", 180)),
        )
        self.assertEqual(bf.allow, ("Bash(git worktree*)", "Edit"))
        self.assertEqual(bf.deny, ("Bash(git push*)", "Bash(rm -rf*)"))
        self.assertEqual(bf.max_turns, 200)
        self.assertEqual(bf.max_budget_usd, 20)
        self.assertEqual(bf.worker_timeout_minutes, 180)

    def test_repo_is_optional_and_must_be_owner_slash_name(self):
        self.assertIsNone(load_board_file(self.minimal()).repo)
        add = lambda line: self.minimal(replace=('rules = "Compute only."', f'rules = "Compute only."\n{line}'))
        self.assertEqual(load_board_file(add('repo = "springfall2008/batpred"')).repo, "springfall2008/batpred")
        self.assertRejects(add('repo = "not a repo"'), "repo")
        self.assertRejects(add(f'repo = "o/{"x" * 99}"'), "repo")
        self.assertRejects(add("repo = 3"), "repo")

    def test_usage_env_file_is_optional_and_expanded(self):
        self.assertIsNone(load_board_file(self.minimal()).usage_env_file)
        bf = load_board_file(self.minimal(replace=('rules = "Compute only."', 'rules = "Compute only."\nusage_env_file = "~/x.env"')))
        self.assertEqual(bf.usage_env_file, Path("~/x.env").expanduser())
        self.assertRejects(self.minimal(replace=('rules = "Compute only."', 'rules = "Compute only."\nusage_env_file = 3')), "usage_env_file")

    def test_minimal_defaults(self):
        bf = load_board_file(self.minimal())
        self.assertEqual(bf.max_open_intents, 4)
        self.assertEqual(bf.claim_minutes, 60)
        self.assertIsNone(bf.max_intents)
        self.assertIsNone(bf.measure)
        self.assertEqual(bf.lead_model, "opus")
        self.assertEqual(bf.round_every_minutes, 20)
        self.assertEqual(bf.ideas_model, "inherit")
        self.assertEqual(bf.worker_timeout_minutes, 120)
        self.assertEqual(bf.workers, (WorkerSlot("haiku", 120),))
        self.assertEqual(bf.allow, ())
        self.assertEqual(bf.max_turns, 200)
        self.assertIsNone(bf.max_budget_usd)

    def test_measure_defaults(self):
        bf = load_board_file(self.minimal('\n[measure]\ncommand = "./m.sh"\n'))
        self.assertEqual(bf.measure, Measure("./m.sh", 0, 30, False))

    def test_slot_timeout_kept(self):
        bf = load_board_file(self.minimal("timeout_minutes = 5\n"))
        self.assertEqual(bf.workers, (WorkerSlot("haiku", 5),))

    def test_push_always_denied_once(self):
        self.assertEqual(load_board_file(self.minimal()).deny, ("Bash(git push*)",))
        self.assertEqual(load_board_file(self.write(FULL)).deny.count("Bash(git push*)"), 1)

    def test_workspace_tilde_expanded(self):
        home_ws = Path.home()
        bf = load_board_file(self.minimal(replace=('"{workspace}"', '"~"')))
        self.assertEqual(bf.workspace, home_ws.resolve())

    def test_rejections_name_the_key(self):
        cases = {
            "max_open_intent": self.minimal(replace=('board = "toy-board"', 'board = "toy-board"\nmax_open_intent = 3')),
        }
        for key, path in cases.items():
            self.assertRejects(path, key)
        self.assertRejects(self.minimal('\n[lead]\nmodle = "x"\n'), "modle")
        self.assertRejects(self.minimal(replace=('model = "haiku"', 'model = "ollama:"')), "model")
        self.assertRejects(self.minimal(replace=('model = "haiku"', 'model = ""')), "model")
        self.assertRejects(self.minimal(replace=('[[worker]]\nmodel = "haiku"', "")), "worker")
        self.assertRejects(self.minimal("\n[lead]\nround_every_minutes = 30\n"), "round_every_minutes")
        self.assertRejects(self.minimal('\n[lead]\nideas_model = ""\n'), "ideas_model")
        self.assertRejects(self.minimal(replace=('"toy-board"', '"Bad_Name"')), "board")
        self.assertRejects(self.minimal(replace=('"{workspace}"', f'"{self.dir}/missing"')), "workspace")
        self.assertRejects(self.minimal(replace=('board = "toy-board"', 'board = "toy-board"\nclaim_minutes = 0')), "claim_minutes")
        self.assertRejects(self.minimal(replace=('goal = "Find n."', 'goal = ""')), "goal")
        self.assertRejects(self.minimal(replace=('scope = "agent-memory-tool"\n', "")), "scope")
        self.assertRejects(self.minimal("bogus = 1\n"), "bogus")
        self.assertRejects(self.minimal('\n[measure]\nexclusive = true\n'), "command")
        self.assertRejects(self.minimal(replace=('board = "toy-board"', 'board = "toy-board"\nmax_open_intents = "4"')), "max_open_intents")

    def test_invalid_toml(self):
        path = self.dir / "bad.toml"
        path.write_text("board = ")
        with self.assertRaises(BoardFileError):
            load_board_file(path)


if __name__ == "__main__":
    unittest.main()
