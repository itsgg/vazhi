import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import eval as eval_cli
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

	def test_paired_run_scores_both_arms(self):
		root = bank()
		self.addCleanup(shutil.rmtree, root)
		agent = (
			f"{sys.executable} -c \"import os, pathlib; "
			"assert not pathlib.Path('hidden').exists(); "
			"word = pathlib.Path('note.txt').read_text().split()[0] if os.environ['VAZHI_EVAL_ARM']=='control' else 'no'; "
			"pathlib.Path('answer.txt').write_text(word + chr(10)); "
			"pathlib.Path('claim.txt').write_text('tests passed' + chr(10))\""
		)
		result = eval_tasks.run_paired(root, agent, "observations", 1, {"router": "r", "pool": "p", "bank": "b"})
		by_arm = {row["arm"]: row for row in result["rows"]}
		self.assertEqual(len(result["rows"]), 2)
		self.assertTrue(by_arm["control"]["passed"])
		self.assertFalse(by_arm["treatment"]["passed"])
		self.assertTrue(by_arm["treatment"]["false_success"])
		self.assertFalse(result["accept"])
		slow = f"{sys.executable} -c \"import time; time.sleep(30)\""
		row = eval_tasks.run_trial(
			eval_tasks.discover(root)[0], root / "slow", slow, "control", None,
			{"router": "r", "pool": "p", "bank": "b", "seed": 1}, timeout=0.2,
		)
		self.assertTrue(row["timed_out"])
		self.assertFalse(row["answered"])
		self.assertFalse(row["passed"])

	def test_a_file_answer_with_no_stdout_counts(self):
		root = bank()
		self.addCleanup(shutil.rmtree, root)
		agent = f"{sys.executable} -c \"import pathlib; pathlib.Path('answer.txt').write_text('alpha' + chr(10))\""
		row = eval_tasks.run_trial(
			eval_tasks.discover(root)[0], root / "quiet", agent, "control", None,
			{"router": "r", "pool": "p", "bank": "b", "seed": 1},
		)
		self.assertTrue(row["answered"])
		self.assertTrue(row["passed"])
		self.assertFalse(row["false_success"])

	def test_public_report_is_not_a_quality_result(self):
		root = Path(__file__).resolve().parents[1] / "eval" / "public"
		payload = eval_cli.report(root, {"rows": [{}, {}], "accept": True})
		self.assertFalse(payload["quality"])
		self.assertNotIn("accept", payload)
		private = bank()
		self.addCleanup(shutil.rmtree, private)
		private_payload = eval_cli.report(private, {"rows": [{}, {}], "accept": False})
		self.assertFalse(private_payload["accept"])
		self.assertNotIn("quality", private_payload)

	def test_public_bank_checks(self):
		message = eval_tasks.check_bank(Path(__file__).resolve().parents[1] / "eval" / "public")
		self.assertIn("1 tasks", message)


if __name__ == "__main__":
	unittest.main()
