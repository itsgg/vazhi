"""Manual diagnostic for three small tasks, one pinned model at a time.

This does not measure vazhi's router and its results do not change rank. The public task bank
is checked with: python3 -I scripts/eval.py --tasks-dir eval/public --check

A paired run of a supplied agent is:
python3 -I scripts/eval.py --tasks-dir <bank> --run --agent '<command>'
The public bank only checks the harness. It is not a quality result.
"""
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WORK = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "vazhi-eval"
RESULTS = ROOT / "data" / "eval.json"
TIMEOUT = 420
ANONYMOUS = {"kilo", "ovh", "llm7"}
KEYS = {"nvidia": "NVIDIA_API_KEY", "google": "GEMINI_API_KEY"}
CONCURRENCY = {"nvidia": 3, "google": 1, "kilo": 2, "ovh": 3, "llm7": 1}
SETTINGS = {
    "defaultProvider": "vazhi",
    "defaultModel": "auto",
    "httpIdleTimeoutMs": 45000,
    "retry": {"enabled": True, "maxRetries": 20, "baseDelayMs": 300, "maxAgentDelayMs": 4000},
}

DURATIONS = '''def parse_duration(text):
    """Parse '1h30m', '45s', '2h', '1h2m3s', '90m' into seconds.

    Whitespace is allowed between parts ('1h 30m'). Raise ValueError on empty
    or malformed input, including a unit without a number or a number without a unit.
    """
    units = {"h": 3600, "m": 60, "s": 1}
    total = 0
    num = ""
    for ch in text:
        if ch.isdigit():
            num += ch
        elif ch in units:
            total += int(num) * units[ch]
    return total
'''

DURATIONS_TEST = '''import unittest
from durations import parse_duration


class TestParseDuration(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(parse_duration("1h30m"), 5400)
        self.assertEqual(parse_duration("45s"), 45)
        self.assertEqual(parse_duration("1h 2m 3s"), 3723)
        self.assertEqual(parse_duration("90m"), 5400)
        self.assertEqual(parse_duration("2h"), 7200)

    def test_invalid(self):
        for bad in ["", "5x", "h", "10", "1h30", "  "]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    parse_duration(bad)


if __name__ == "__main__":
    unittest.main()
'''

SHOP = {
    "shop/__init__.py": "",
    "shop/pricing.py": '''def calc_total(items, tax):
    """items: list of (price, qty). tax: fraction, e.g. 0.08."""
    subtotal = sum(price * qty for price, qty in items)
    return subtotal * (1 + tax)
''',
    "shop/cart.py": '''from shop.pricing import calc_total


class Cart:
    def __init__(self, discount=0.0):
        self.items = []
        self.discount = discount

    def add(self, price, qty=1):
        self.items.append((price, qty))

    def total(self, tax=0.08):
        return calc_total(self.items, tax)
''',
    "shop/report.py": '''from shop.pricing import calc_total


def summary(carts, tax=0.08):
    return sum(calc_total(c.items, tax) for c in carts)
''',
    "main.py": '''from shop.cart import Cart

cart = Cart(discount=0.1)
cart.add(40, 2)
cart.add(20)
print(f"TOTAL {cart.total():.2f}")
''',
}

PROMPTS = {
    "bugfix": "The tests in test_durations.py fail. Fix durations.py so that `python3 -m unittest -q` passes. Do not edit the tests.",
    "refactor": (
        "In this project, rename the function calc_total to compute_total everywhere it is defined or used. "
        "Also give it a keyword-only parameter discount=0.0, a fraction applied to the subtotal before tax, "
        "and make Cart.total pass the cart's discount. `python3 main.py` must then print `TOTAL 97.20`."
    ),
    "logs": (
        "Log files are under logs/, in nested directories. Error lines look like "
        "`2026-10-01T10:00:00 ERROR [service] message`. Find the service with the most ERROR lines "
        "across all files and write only its name to answer.txt."
    ),
}


def make_logs(root: Path) -> str:
    rng = random.Random(42)
    services = ["auth", "billing", "search", "mailer", "gateway"]
    counts = {s: 0 for s in services}
    weights = {"auth": 3, "billing": 2, "search": 5, "mailer": 1, "gateway": 4}
    for i in range(24):
        d = root / "logs" / f"node{i % 4}" / f"2026-10-{(i % 9) + 1:02d}"
        d.mkdir(parents=True, exist_ok=True)
        lines = []
        for j in range(rng.randint(40, 120)):
            s = rng.choice(services)
            level = "ERROR" if rng.random() < weights[s] / 12 else rng.choice(["INFO", "WARN", "DEBUG"])
            if level == "ERROR":
                counts[s] += 1
            lines.append(f"2026-10-01T{j % 24:02d}:{j % 60:02d}:00 {level} [{s}] event {j}")
        # decoy: many WARN lines for gateway that mention ERROR in the message
        lines += [f"2026-10-01T00:00:00 WARN [gateway] retrying after ERROR {k}" for k in range(rng.randint(5, 15))]
        (d / f"app-{i}.log").write_text("\n".join(lines) + "\n")
    return max(counts, key=counts.get)


def setup(task: str, d: Path) -> dict:
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    if task == "bugfix":
        (d / "durations.py").write_text(DURATIONS)
        (d / "test_durations.py").write_text(DURATIONS_TEST)
        return {"test_hash": hashlib.sha256(DURATIONS_TEST.encode()).hexdigest()}
    if task == "refactor":
        for name, body in SHOP.items():
            (d / name).parent.mkdir(parents=True, exist_ok=True)
            (d / name).write_text(body)
        return {}
    return {"answer": make_logs(d)}


def check(task: str, d: Path, meta: dict) -> tuple[bool, str]:
    def run(*cmd):
        return subprocess.run(cmd, cwd=d, capture_output=True, text=True, timeout=60)

    if task == "bugfix":
        if hashlib.sha256((d / "test_durations.py").read_bytes()).hexdigest() != meta["test_hash"]:
            return False, "tests edited"
        r = run(sys.executable, "-m", "unittest", "-q")
        return r.returncode == 0, (r.stderr.strip().splitlines() or [""])[-1]
    if task == "refactor":
        leftover = run("grep", "-rn", "calc_total", "--include=*.py", ".").stdout.strip()
        out = run(sys.executable, "main.py").stdout.strip()
        sig = run(sys.executable, "-c", "import inspect, shop.pricing as p; print(inspect.signature(p.compute_total).parameters['discount'].kind.name)").stdout.strip()
        ok = not leftover and out == "TOTAL 97.20" and sig == "KEYWORD_ONLY"
        return ok, f"out={out!r} sig={sig!r} leftover={bool(leftover)}"
    got = (d / "answer.txt").read_text().strip() if (d / "answer.txt").exists() else ""
    return got == meta["answer"], f"got={got!r} want={meta['answer']!r}"


def agent_dir(entry: dict) -> Path:
    a = WORK / "agents" / entry["model"].replace("/", "_")
    shutil.rmtree(a, ignore_errors=True)
    (a / "vazhi").mkdir(parents=True)
    (a / "settings.json").write_text(json.dumps(SETTINGS))
    pool_entry = {k: entry[k] for k in ("model", "rpm") if k in entry}
    (a / "vazhi" / "config.json").write_text(json.dumps({"pool": [pool_entry], "autoUpdate": False}))
    return a


lock = threading.Lock()

_IDS = re.compile(r"(account|org|organization|project|consumer|user|tenant)([_-]?id)?(['\":=\s]+)[A-Za-z0-9_./-]{6,}", re.I)


def redact(text: str) -> str:
    """Provider errors can carry account and project identifiers; CI logs are public."""
    text = _IDS.sub(r"\1\2\3<redacted>", text)
    text = re.sub(r"projects/\d+", "projects/<redacted>", text)
    return re.sub(r"Bearer\s+[A-Za-z0-9._-]+", "Bearer <redacted>", text)


def run_one(entry: dict, task: str) -> dict:
    model = entry["model"]
    d = WORK / "tasks" / model.replace("/", "_") / task
    meta = setup(task, d)
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent_dir(entry))}
    cmd = ["pi", "-p", "--mode", "json", "--no-session", "--no-skills", "--no-context-files",
           "-e", str(ROOT / "src" / "index.ts"), "--tools", "read,bash,edit,write", "--model", "vazhi/auto", PROMPTS[task]]
    start = time.time()
    try:
        p = subprocess.run(cmd, cwd=d, env=env, capture_output=True, text=True, timeout=TIMEOUT, stdin=subprocess.DEVNULL)
        stdout = p.stdout
    except subprocess.TimeoutExpired as e:
        stdout = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
    secs = round(time.time() - start, 1)
    requests = answered = 0
    last_error = ""
    for line in stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "message_end" and e["message"].get("role") == "assistant":
            requests += 1
            if e["message"].get("stopReason") == "error":
                last_error = redact((e["message"].get("errorMessage") or "")[:160])
            else:
                answered += 1
    ok, detail = check(task, d, meta)
    # A run that never got an answer measured the provider's limits, not the model.
    skipped = not ok and answered == 0
    rec = {"model": model, "task": task, "pass": ok, "skipped": skipped, "secs": secs, "requests": requests,
           "detail": detail, "last_error": last_error}
    with lock:
        print(json.dumps(rec), flush=True)
    return rec


def reachable(model: str) -> bool:
    provider = model.split("/", 1)[0]
    return provider in ANONYMOUS or bool(os.environ.get(KEYS.get(provider, ""), ""))


PUBLIC = ROOT / "eval" / "public"


def report(root: Path, result: dict) -> dict:
    """The shipped public bank can exercise the harness. It is not a quality gate."""
    sys.path.insert(0, str(HERE))
    from eval_tasks import bank_hash

    payload = {"rows": len(result["rows"]), "bank": bank_hash(root)[:12]}
    if root.resolve() == PUBLIC.resolve():
        payload["quality"] = False
    else:
        payload["accept"] = result["accept"]
    return payload


def main():
    if "--tasks-dir" in sys.argv:
        sys.path.insert(0, str(HERE))
        from eval_tasks import check_bank

        root = Path(sys.argv[sys.argv.index("--tasks-dir") + 1])
        if "--check" in sys.argv:
            print(check_bank(root))
            return
        if "--run" not in sys.argv or "--agent" not in sys.argv:
            raise SystemExit("pass --check, or --run --agent <command>; a public bank is not a quality result")
        from eval_tasks import bank_hash, run_paired

        agent = sys.argv[sys.argv.index("--agent") + 1]
        experiment = sys.argv[sys.argv.index("--experiment") + 1] if "--experiment" in sys.argv else None
        seed = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 1
        result = run_paired(root, agent, experiment, seed, {"router": "local", "pool": "local", "bank": bank_hash(root)})
        print(json.dumps(report(root, result)))
        return
    top = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 10
    pool = json.loads((ROOT / "pool.json").read_text())["pool"]
    entries = [e for e in pool if e.get("status") == "ok" and reachable(e["model"])][:top]
    results: dict[str, list] = {}

    def run_model(entry):
        results[entry["model"]] = [run_one(entry, task) for task in PROMPTS]

    by_provider: dict[str, list] = {}
    for e in entries:
        by_provider.setdefault(e["model"].split("/", 1)[0], []).append(e)
    with ThreadPoolExecutor(len(by_provider) or 1) as outer:
        def provider_run(provider, es):
            with ThreadPoolExecutor(CONCURRENCY.get(provider, 1)) as inner:
                list(inner.map(run_model, es))
        list(outer.map(lambda pe: provider_run(*pe), by_provider.items()))

    data = json.loads(RESULTS.read_text()) if RESULTS.exists() else {"models": {}}
    today = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for model, recs in results.items():
        counted = [r for r in recs if not r["skipped"]]
        if not counted:
            continue
        data["models"][model] = {
            "passed": sum(r["pass"] for r in counted),
            "total": len(counted),
            "at": today,
            "tasks": {r["task"]: {k: r[k] for k in ("pass", "secs", "requests", "detail")} for r in counted},
        }
    data["generated"] = today
    RESULTS.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
