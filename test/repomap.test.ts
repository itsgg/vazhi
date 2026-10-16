import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repositoryMap } from "../src/repomap.ts";

test("repository map is capped and skips dependency trees", () => {
	const root = mkdtempSync(join(tmpdir(), "vazhi-map-"));
	try {
		mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(root, "node_modules", "pkg", "skip.py"), "def hidden():\n    pass\n");
		writeFileSync(join(root, "sample.py"), "def alpha():\n    return 1\n");
		for (let i = 0; i < 20; i++) writeFileSync(join(root, `f${String(i).padStart(2, "0")}.py`), `def item${i}():\n    pass\n`);
		const map = repositoryMap(root, { maxFiles: 3, maxLines: 2 });
		assert.ok(map);
		assert.equal(map.split("\n").length, 2);
		assert.doesNotMatch(map, /hidden/);
		assert.equal(repositoryMap(join(root, "node_modules")), undefined);
		symlinkSync(join(root, "node_modules"), join(root, "alias"));
		assert.doesNotMatch(repositoryMap(root) ?? "", /hidden/);
		const cycle = mkdtempSync(join(tmpdir(), "vazhi-cycle-"));
		symlinkSync(join(cycle, "b"), join(cycle, "a"));
		symlinkSync(join(cycle, "a"), join(cycle, "b"));
		assert.equal(repositoryMap(cycle), undefined);
		rmSync(cycle, { recursive: true, force: true });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
