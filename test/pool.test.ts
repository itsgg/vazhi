import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPool, parsePool, refreshRemote, REMOTE_URL, type PoolFile } from "../src/pool.ts";

const meta = { id: "m1:free", name: "M1", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 32768 };

function pool(generated: string, models: string[]): PoolFile {
	return parsePool({ version: 1, generated, sharedLimits: ["kilo"], models: { kilo: [meta] }, pool: models.map((model) => ({ model })) });
}

test("the downloaded pool can only name free providers", () => {
	const p = parsePool({
		version: 1,
		generated: "x",
		models: {},
		pool: [
			{ model: "nvidia/z-ai/glm-5.3-flash" },
			{ model: "anthropic/claude-opus-5" },
			{ model: "openrouter/anthropic/claude-opus-5" },
			{ model: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free" },
			{ model: "kilo/anything:free" },
			{ model: "evil provider/x" },
			{ model: "noslash" },
		],
	});
	assert.deepEqual(
		p.pool.map((e) => e.model),
		["nvidia/z-ai/glm-5.3-flash", "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "kilo/anything:free"],
	);
});

test("model metadata is only taken for vazhi's own providers, and only when sane", () => {
	const p = parsePool({
		version: 1,
		pool: [],
		models: {
			kilo: [meta, { ...meta, id: "bad:free", maxTokens: 999999999 }, { ...meta, id: "x:free", input: ["audio"] }],
			nvidia: [meta],
		},
	});
	assert.deepEqual(p.models.kilo.map((m) => m.id), ["m1:free"]);
	assert.equal((p.models as any).nvidia, undefined);
	const free = parsePool({ version: 1, pool: [], models: { kilo: [{ ...meta, id: "x/y:free" }, { ...meta, id: "anthropic/claude-opus-5" }] } });
	assert.deepEqual(free.models.kilo.map((m) => m.id), ["x/y:free"], "a paid Kilo model's metadata is dropped (review finding 1)");
});

test("a pool file without version 1 is refused", () => {
	assert.throws(() => parsePool({ pool: [] }));
});

test("loadPool: newer nightly beats bundled; config can exclude, prefer and replace", () => {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-pool-"));
	const bundled = pool("2026-10-01", ["nvidia/a", "kilo/b:free"]);
	assert.equal(loadPool(dir, bundled).source, "bundled");

	writeFileSync(join(dir, "pool-cache.json"), JSON.stringify({ fetchedAt: 1, pool: pool("2026-10-02", ["nvidia/a", "kilo/b:free", "ovh/c"]) }));
	const nightly = loadPool(dir, bundled);
	assert.equal(nightly.source, "nightly");
	assert.equal(nightly.pool.pool.length, 3);

	writeFileSync(join(dir, "pool-cache.json"), JSON.stringify({ fetchedAt: 1, pool: pool("2026-09-01", ["ovh/c"]) }));
	assert.equal(loadPool(dir, bundled).source, "bundled", "an older nightly loses to a newer package");

	writeFileSync(join(dir, "config.json"), JSON.stringify({ exclude: ["kilo"], prefer: ["google/gemini-3.8-flash"] }));
	assert.deepEqual(
		loadPool(dir, bundled).pool.pool.map((e) => e.model),
		["google/gemini-3.8-flash", "nvidia/a"],
	);

	writeFileSync(join(dir, "config.json"), JSON.stringify({ pool: [{ model: "anthropic/claude-opus-5" }] }));
	const own = loadPool(dir, bundled);
	assert.equal(own.source, "config");
	assert.deepEqual(own.pool.pool.map((e) => e.model), ["anthropic/claude-opus-5"], "the user's own pool is not restricted");

	writeFileSync(join(dir, "config.json"), '{"pool": [{"mod');
	assert.equal(loadPool(dir, bundled).source, "config", "a half-saved config keeps the last good one");
	rmSync(dir, { recursive: true, force: true });
});

test("refreshRemote fetches at most every 12 hours, keeps the cache on failure, honours autoUpdate", async () => {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-refresh-"));
	let calls = 0;
	const serve = (body: unknown, status = 200) =>
		(async (url: string) => {
			calls++;
			assert.equal(url, REMOTE_URL);
			return new Response(JSON.stringify(body), { status });
		}) as unknown as typeof fetch;

	assert.equal(await refreshRemote(dir, { fetch: serve(pool("2026-10-02", ["nvidia/a"])), now: 1_000 }), true);
	assert.equal(await refreshRemote(dir, { fetch: serve(pool("2026-10-03", ["nvidia/b"])), now: 2_000 }), false, "within 12 h");
	assert.equal(calls, 1);

	const later = 1_000 + 13 * 3600 * 1000;
	assert.equal(await refreshRemote(dir, { fetch: serve({ nope: true }), now: later }), false, "bad body");
	const cached = JSON.parse(readFileSync(join(dir, "pool-cache.json"), "utf8"));
	assert.equal(cached.pool.generated, "2026-10-02", "failure keeps the last good pool");

	writeFileSync(join(dir, "config.json"), JSON.stringify({ autoUpdate: false }));
	assert.equal(await refreshRemote(dir, { fetch: serve(pool("2026-10-04", ["nvidia/c"])), now: later * 2, force: true }), false);
	assert.equal(calls, 2, "autoUpdate false never fetches");
	rmSync(dir, { recursive: true, force: true });
});
