import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { redact } from "../scripts/discover.ts";
import { parsePool } from "../src/pool.ts";
import { allowedInRemotePool } from "../src/providers.ts";

test("the committed pool.json parses, keeps every row and names only allowed providers", () => {
	const raw = JSON.parse(readFileSync(new URL("../pool.json", import.meta.url), "utf8"));
	const pool = parsePool(raw);
	assert.ok(pool.pool.length >= 5, "a pool this small means discovery broke");
	assert.equal(pool.pool.length, raw.pool.length, "every committed row survives validation");
	for (const { model } of pool.pool) {
		const slash = model.indexOf("/");
		assert.ok(allowedInRemotePool(model.slice(0, slash), model.slice(slash + 1)), model);
	}
});

test("committed model lists are sorted, so catalog reordering does not churn pool.json (review finding 17)", () => {
	const raw = JSON.parse(readFileSync(new URL("../pool.json", import.meta.url), "utf8"));
	for (const [provider, list] of Object.entries(raw.models) as [string, { id: string }[]][]) {
		const ids = list.map((m) => m.id);
		assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)), provider);
	}
});

test("probe errors lose account and project identifiers before they reach public logs", () => {
	const nim = `404 {"detail":"Function 'ee47df99': Not found for account 'AbCdEf12-fakeAccountId0000000000'"}`;
	assert.doesNotMatch(redact(nim), /AbCdEf12/);
	assert.doesNotMatch(redact('"consumer": "projects/123456789012"'), /123456789012/);
	assert.doesNotMatch(redact("Authorization: Bearer nvapi-abcdef123456"), /nvapi-abcdef/);
	assert.match(redact("429 Too Many Requests"), /429 Too Many Requests/);
	assert.doesNotMatch(redact('{"account_id":"acct_9f8e7d6c","project_id":"proj-12345678"}'), /acct_9f8e|proj-1234/, "review finding 6");
});

test("eval.py redacts the same identifiers before printing (review finding 6)", () => {
	const py = spawnSync(
		"python3",
		["-I", "-c", "import importlib.util,sys; s=importlib.util.spec_from_file_location('ev', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.redact(sys.argv[2]))",
			fileURLToPath(new URL("../scripts/eval.py", import.meta.url)),
			"404 for account 'AbCdEf12-fakeAccountId00' project_id: my-proj-123 Bearer nvapi-xyz123"],
		{ encoding: "utf8" },
	);
	assert.equal(py.status, 0, py.stderr);
	assert.doesNotMatch(py.stdout, /AbCdEf12|my-proj-123|nvapi-xyz/);
});
