import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import eval_stats


def row(task, passed, false_success=False):
	return {"task": task, "passed": passed, "false_success": false_success}


class EvalStatsTest(unittest.TestCase):
	def test_arm_order_is_seeded_and_paired(self):
		order = eval_stats.arm_order(["a", "b"], 7)
		self.assertEqual([item[0] for item in order], ["a", "a", "b", "b"])
		self.assertEqual(sorted(arm for _, arm in order[:2]), ["control", "treatment"])
		self.assertEqual(order, eval_stats.arm_order(["a", "b"], 7))

	def test_pass_at_three_requires_three_consecutive_successes(self):
		self.assertEqual(eval_stats.pass_at_k([True, True, True, False], 1), 0.75)
		self.assertEqual(eval_stats.pass_at_k([True, True, True, False], 3), 0.5)

	def test_a_uniform_gain_has_an_interval_above_zero(self):
		interval = eval_stats.paired_interval([1, 1, 1, 1])
		self.assertGreater(interval["low"], 0)

	def test_false_success_blocks_acceptance(self):
		control = [row("a", False), row("b", False)]
		treatment = [row("a", True, True), row("b", True, True)]
		self.assertFalse(eval_stats.accept(control, treatment))
		self.assertTrue(eval_stats.accept(control, [row("a", True), row("b", True)]))


if __name__ == "__main__":
	unittest.main()
