"""Paired summaries for a frozen control/treatment evaluation."""
import math
import random

EXPERIMENTS = ("observations", "stickiness", "clean-retry", "task-class", "repo-map")


def arm_order(task_ids: list[str], seed: int) -> list[tuple[str, str]]:
	rng = random.Random(seed)
	order = []
	for task_id in task_ids:
		first = "treatment" if rng.randrange(2) else "control"
		second = "control" if first == "treatment" else "treatment"
		order.append((task_id, first))
		order.append((task_id, second))
	return order


def pass_at_k(trials: list[bool], k: int) -> float:
	if len(trials) < k:
		raise ValueError("not enough trials")
	return sum(all(trials[i : i + k]) for i in range(0, len(trials) - k + 1)) / (len(trials) - k + 1)


def paired_interval(diffs: list[float]) -> dict:
	n = len(diffs)
	if n == 0:
		raise ValueError("no paired differences")
	mean = sum(diffs) / n
	if n == 1:
		return {"mean": mean, "low": mean, "high": mean}
	variance = sum((value - mean) ** 2 for value in diffs) / (n - 1)
	margin = math.sqrt(variance / n) * 1.96
	return {"mean": mean, "low": mean - margin, "high": mean + margin}


def accept(control: list[dict], treatment: list[dict]) -> bool:
	by_task = {row["task"]: row for row in control}
	diffs = [int(treatment_row["passed"]) - int(by_task[treatment_row["task"]]["passed"]) for treatment_row in treatment]
	interval = paired_interval(diffs)
	false_success = sum(row["false_success"] for row in treatment) <= sum(row["false_success"] for row in control)
	return interval["low"] > 0 and false_success
