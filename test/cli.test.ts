import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-cli-"));
	dirs.push(dir);
	mkdirSync(join(dir, "vazhi"));
	// No keys, no downloads, and a fast list of one keyless model on a port nothing listens on.
	writeFileSync(join(dir, "vazhi", "config.json"), JSON.stringify({ autoUpdate: false, fast: [{ model: "ovh/m" }] }));
	writeFileSync(join(dir, "auth.json"), "{}");
	return dir;
}

function run(args: string[], options: { input?: string; dir?: string; script?: string } = {}) {
	const dir = options.dir ?? agentDir();
	const env = { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir };
	return spawnSync(process.execPath, [options.script ?? join(root, "src/cli.ts"), ...args], { encoding: "utf8", input: options.input ?? "", env, timeout: 20_000 });
}

test("usage: --help exits 0, no command and unknown commands exit 2", () => {
	assert.equal(run(["--help"]).status, 0);
	assert.match(run(["--help"]).stdout, /vazhi ask/);
	assert.equal(run([]).status, 2);
	const unknown = run(["frobnicate"]);
	assert.equal(unknown.status, 2);
	assert.match(unknown.stderr, /unknown command/);
});

test("ask: nothing to ask and a bad --max-tokens are usage errors", () => {
	assert.equal(run(["ask"]).status, 2);
	assert.equal(run(["ask", "--max-tokens", "lots", "q"]).status, 2);
	assert.equal(run(["ask", "--nope", "q"]).status, 2);
});

test("ask: no usable model exits 1 with the reason on stderr and nothing on stdout", () => {
	const dir = agentDir();
	writeFileSync(join(dir, "vazhi", "config.json"), JSON.stringify({ autoUpdate: false, fast: [{ model: "groq/x" }] }));
	const out = run(["ask", "--fast", "list files"], { dir });
	assert.equal(out.status, 1);
	assert.equal(out.stdout, "");
	assert.match(out.stderr, /no fast-list model has a key/);
});

test("status and reset work against the shared state", () => {
	const dir = agentDir();
	writeFileSync(
		join(dir, "vazhi", "state.json"),
		JSON.stringify({ models: { "ovh/m": { until: Date.now() + 60_000, failures: 1, reason: "rate: test", at: Date.now() } } }),
	);
	assert.match(run(["status", "--fast"], { dir }).stdout, /ovh\/m {2}cooling \d+s \(rate: test\)/);
	assert.equal(run(["reset"], { dir }).status, 0);
	assert.match(run(["status", "--fast"], { dir }).stdout, /ovh\/m {2}ready/);
});

test("the published bin runs: a build under node_modules-free dist answers --version", () => {
	const out = mkdtempSync(join(tmpdir(), "vazhi-build-"));
	dirs.push(out);
	const tsc = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json"), "--outDir", join(out, "dist")], {
		encoding: "utf8",
	});
	assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
	// dist/cli.js reads ../package.json and ../pool.json, as it does from the package root.
	writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module", version: "9.9.9" }));
	writeFileSync(join(out, "pool.json"), JSON.stringify({ version: 1, pool: [] }));
	const version = run(["--version"], { script: join(out, "dist/cli.js") });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), "9.9.9");
});
