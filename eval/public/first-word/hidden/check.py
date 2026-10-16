import sys
from pathlib import Path

got = Path("answer.txt").read_text().strip() if Path("answer.txt").exists() else ""
sys.exit(0 if got == "alpha" else 1)
