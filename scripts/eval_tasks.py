"""Task-bank helpers for full-pool evaluation.

A task directory contains task.json, workspace/, and hidden/check.py. The agent
workspace never receives the hidden check. Public fixtures validate this harness;
they are not a quality benchmark.
"""
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

EXPERIMENTS = ("observations", "stickiness", "clean-retry", "task-class", "repo-map")
REQUIRED = ("arm", "task", "passed", "false_success", "answered", "timed_out", "router", "pool", "bank", "seed")


def discover(root: Path) -> list[dict]:
	tasks = []
	for path in sorted(p for p in root.iterdir() if p.is_dir()):
		manifest_path = path / "task.json"
		if not manifest_path.exists():
			continue
		manifest = json.loads(manifest_path.read_text())
		if manifest.get("id") != path.name or not isinstance(manifest.get("prompt"), str):
			raise ValueError(f"{path.name}: task id and prompt are required")
		hidden = path / "hidden" / "check.py"
		workspace = path / "workspace"
		if not hidden.is_file() or not workspace.is_dir():
			raise ValueError(f"{path.name}: workspace and hidden/check.py are required")
		tasks.append({"id": path.name, "prompt": manifest["prompt"], "root": path, "workspace": workspace, "hidden": hidden})
	if not tasks:
		raise ValueError(f"no tasks in {root}")
	return tasks


def prepare(task: dict, dest: Path) -> None:
	if dest.exists():
		shutil.rmtree(dest)
	shutil.copytree(task["workspace"], dest)
	if (dest / "hidden").exists():
		raise ValueError("hidden checks must stay outside the workspace")


def score(task: dict, workspace: Path) -> tuple[bool, str]:
	try:
		result = subprocess.run(
			[sys.executable, str(task["hidden"])],
			cwd=workspace,
			capture_output=True,
			text=True,
			timeout=30,
		)
	except subprocess.TimeoutExpired:
		return False, "hidden check timed out"
	detail = (result.stderr or result.stdout).strip().splitlines()
	return result.returncode == 0, detail[-1] if detail else ""


def bank_hash(root: Path) -> str:
	body = []
	for task in discover(root):
		body.append(task["prompt"])
		body.append(task["hidden"].read_text())
	return hashlib.sha256("\n".join(body).encode()).hexdigest()


def result_row(fields: dict) -> dict:
	missing = [key for key in REQUIRED if key not in fields]
	if missing:
		raise ValueError(f"missing result fields: {', '.join(missing)}")
	if fields["experiment"] not in (None, *EXPERIMENTS):
		raise ValueError(f"unknown experiment {fields['experiment']}")
	if fields["timed_out"] or not fields["answered"]:
		fields = {**fields, "passed": False}
	return fields


def check_bank(root: Path) -> str:
	tasks = discover(root)
	for task in tasks:
		dest = root / ".check" / task["id"]
		prepare(task, dest)
		shutil.rmtree(root / ".check")
	return f"{len(tasks)} tasks, bank {bank_hash(root)[:12]}"
