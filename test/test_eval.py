import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import eval_tasks


def bank() -> Path:
	root = Path(tempfile.mkdtemp())
	task = root / "alpha"
	(task / "workspace").mkdir(parents=True)
	(task / "hidden").mkdir()
	(task / "workspace" / "note.txt").write_text("alpha beta\n")
	(task / "hidden" / "check.py").write_text(
		"from pathlib import Path\n"
		"import sys\n"
		"got = Path('answer.txt').read_text().strip() if Path('answer.txt').exists() else ''\n"
		"sys.exit(0 if got == 'alpha' else 1)\n"
	)
	(task / "task.json").write_text(json.dumps({"id": "alpha", "prompt": "Write the first word of note.txt to answer.txt."}))
	return root


class EvalTasksTest(unittest.TestCase):
	def test_hidden_check_stays_outside_the_workspace(self):
		root = bank()
		self.addCleanup(shutil.rmtree, root)
		task = eval_tasks.discover(root)[0]
		dest = root / "run"
		eval_tasks.prepare(task, dest)
		self.assertFalse((dest / "hidden").exists())
		self.assertTrue((dest / "note.txt").exists())

	def test_timeout_or_no_answer_is_a_failure(self):
		row = eval_tasks.result_row({
			"arm": "control", "task": "alpha", "passed": True, "false_success": False,
			"answered": False, "timed_out": True, "router": "abc", "pool": "def", "bank": "123",
			"seed": 1, "experiment": "observations",
		})
		self.assertFalse(row["passed"])

	def test_unknown_experiment_is_rejected(self):
		with self.assertRaises(ValueError):
			eval_tasks.result_row({
				"arm": "control", "task": "alpha", "passed": False, "false_success": False,
				"answered": True, "timed_out": False, "router": "a", "pool": "b", "bank": "c",
				"seed": 1, "experiment": "judge",
			})

	def test_public_bank_checks(self):
		message = eval_tasks.check_bank(Path(__file__).resolve().parents[1] / "eval" / "public")
		self.assertIn("1 tasks", message)


if __name__ == "__main__":
	unittest.main()
