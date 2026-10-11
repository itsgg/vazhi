import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	choose,
	classify,
	clientReroute,
	emptyState,
	HOUR,
	MINUTE,
	parseRetryAfter,
	penalize,
	pickWithin,
	recover,
	reserve,
	Store,
	type Choice,
} from "../src/router.ts";

test("parseRetryAfter reads the wordings providers use, with units", () => {
	const cases: [string, number | undefined][] = [
		['429: {"message":"Daily token quota exceeded. Retry after 88676 seconds.","retry_after":88676}', 88_676_000],
		["Please retry after 2 minutes", 120_000],
		["Retry-After: 100ms", 100],
		['{"retry_after":7}', 7_000],
		["Rate limit reached on tokens per day (TPD): Please try again in 7m12.5s.", 432_500],
		["Rate limit reached on requests per minute. Please try again in 2.5s", 2_500],
		["Please try again in 2 minutes.", 120_000],
		['Resource has been exhausted. Please retry in 23.4s. {"retryDelay":"23s"}', 23_400],
		["Too many concurrent requests for this client. Retry after 10 seconds.", 10_000],
		["503 Service Unavailable", undefined],
	];
	for (const [text, want] of cases) assert.equal(parseRetryAfter(text), want, text);
});

test("classify puts each error in the right kind", () => {
	const cases: [string, string][] = [
		["429 quota exceeded for requests per minute", "minute"],
		["hourly quota exceeded", "hourly"],
		["403 Forbidden: model not enabled for this project", "denied"],
		["401: Your authentication token is invalid.", "auth"],
		['400 {"message":"API key not valid. Please pass a valid API key.","reason":"API_KEY_INVALID"}', "auth"],
		["503 service currently unavailable", "other"],
		['404 "The requested model is currently unavailable." unavailable_model', "gone"],
		["410 Gone: model retired", "gone"],
		["402 Payment Required", "quota"],
		['400 {"error":{"message":"Provider returned error"}}', "client"],
		["Daily token quota exceeded", "daily"],
		["429 Too Many Requests", "rate"],
		["Request timed out.", "slow"],
	];
	for (const [text, want] of cases) assert.equal(classify(text).kind, want, text);
});

test("penalize never shortens a cooldown", () => {
	const s = emptyState();
	penalize(s, "google/a", "Daily limit reached", 0);
	penalize(s, "google/a", "429 Too Many Requests", 0);
	assert.equal(s.models["google/a"].until, HOUR);
});

test("a stated delay beats the backoff guess", () => {
	assert.equal(penalize(emptyState(), "google/g", "429 Resource has been exhausted. Please retry in 23.4s.", 0), 23_400);
});

test("a timeout cools for 15 minutes, then 30", () => {
	const s = emptyState();
	assert.equal(penalize(s, "nvidia/k", "Request timed out.", 0), 15 * MINUTE);
	assert.equal(penalize(s, "nvidia/k", "Request timed out.", 0), 30 * MINUTE);
});

test("backoff doubles on repeated failures", () => {
	const s = emptyState();
	const first = penalize(s, "x/y", "503", 0);
	assert.equal(penalize(s, "x/y", "503", 0), 2 * first);
});

test("whole-provider cooldowns only for shared limits and bad keys", () => {
	const s = emptyState();
	penalize(s, "google/a", "429 rate limit", 0, ["kilo"]);
	penalize(s, "google/b", "429 rate limit", 1000, ["kilo"]);
	assert.equal(s.providers.google, undefined, "per-model provider");
	penalize(s, "kilo/a", "429 rate limit", 0, ["kilo"]);
	penalize(s, "kilo/b", "429 rate limit", 1000, ["kilo"]);
	assert.ok(s.providers.kilo, "shared-limit provider");
	penalize(s, "ovh/a", "401 invalid api key", 0);
	assert.ok(s.providers.ovh, "bad key");
	penalize(s, "nvidia/a", "403 Forbidden", 0);
	assert.equal(s.providers.nvidia, undefined, "bare 403 stays with the model");
	assert.ok(s.models["nvidia/a"]);
});

test("recover clears the model, its provider and the shared-limit trail", () => {
	const s = emptyState();
	penalize(s, "kilo/a", "429 rate limit", 0, ["kilo"]);
	penalize(s, "kilo/b", "429 rate limit", 1000, ["kilo"]);
	recover(s, "kilo/b", 2000);
	assert.equal(s.models["kilo/b"], undefined);
	assert.equal(s.providers.kilo, undefined);
	assert.equal(s.lastLimit.kilo, undefined);
});

test("a success that started before a cooldown was set leaves it (review finding 5)", () => {
	const s = emptyState();
	penalize(s, "kilo/a", "429 rate limit", 5000, ["kilo"]);
	penalize(s, "kilo/b", "429 rate limit", 6000, ["kilo"]);
	recover(s, "kilo/c", 1000); // dispatched at 1000, answered after the provider cooled at 6000
	assert.ok(s.providers.kilo, "provider-wide cooldown survives");
	recover(s, "kilo/c", 7000);
	assert.equal(s.providers.kilo, undefined, "a request started after it does clear it");
});

test("choose never sends to a cooling or capped model", () => {
	const a = { model: "p/a" };
	const b = { model: "q/b" };
	const c = { model: "ovh/c", rpm: 2 };
	const s = emptyState();
	s.models["p/a"] = { until: 5_000, failures: 1, reason: "x", at: 0 };
	s.models["q/b"] = { until: 9_000, failures: 1, reason: "x", at: 0 };
	const all = choose([a, b], s, 0);
	assert.ok(!all.pick && all.next === a && all.waitMs === 5_000);
	reserve(s, c, 0);
	reserve(s, c, 1);
	const capped = choose([c], s, 2);
	assert.ok(!capped.pick && capped.waitMs === MINUTE - 2);
});

test("choose: retries avoid the failed model, turns stay on theirs", () => {
	const a = { model: "p/a" };
	const b = { model: "q/b" };
	const s = emptyState();
	assert.equal(choose([a, b], s, 0, undefined, "p/a").pick, b);
	assert.equal(choose([a], s, 0, undefined, "p/a").pick, a, "only model left");
	assert.equal(choose([a, b], s, 0, "q/b").pick, b, "continuation");
	assert.equal(choose([a, b], s, 0).pick, a, "new turn takes the best");
});

test("Store survives corrupt files", () => {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-store-"));
	const store = new Store(dir);
	writeFileSync(store.file, '{"models":null,"dispatched":7}');
	assert.deepEqual(store.load().models, {});
	writeFileSync(store.file, "{not json");
	assert.deepEqual(store.load(), emptyState());
	rmSync(dir, { recursive: true, force: true });
});

test("Store updates are atomic across processes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-lock-"));
	const router = fileURLToPath(new URL("../src/router.ts", import.meta.url));
	const worker = join(dir, "worker.mts");
	writeFileSync(
		worker,
		`const { Store } = await import(${JSON.stringify(router)});\n` +
			// start together, or each process finishes before the next has loaded
			`while (Date.now() < Number(process.env.START)) {}\n` +
			`const store = new Store(${JSON.stringify(dir)});\n` +
			`for (let i = 0; i < 150; i++) store.update((s) => { (s.dispatched.n ??= []).push(i); });\n`,
	);
	const env = { ...process.env, START: String(Date.now() + 3000) };
	const codes = await Promise.all(
		Array.from({ length: 4 }, () => new Promise((resolve) => spawn(process.execPath, [worker], { env, stdio: "inherit" }).on("exit", resolve))),
	);
	assert.deepEqual(codes, [0, 0, 0, 0]);
	assert.equal(new Store(dir).load().dispatched.n.length, 600);
	rmSync(dir, { recursive: true, force: true });
});

test("pickWithin bounds the total wait, not each sleep (review finding 4)", async () => {
	let now = 0;
	const next = { model: "p/a" };
	const choice: Choice = { next, waitMs: 40_000 };
	let sleeps = 0;
	const result = await pickWithin(
		() => choice,
		65_000,
		async (ms) => {
			sleeps++;
			now += ms;
		},
		() => now,
	);
	assert.equal(result.pick, undefined);
	assert.equal(sleeps, 1, "one 40 s wait fits in 65 s, a second does not");
	const ready = await pickWithin(() => ({ pick: next }), 65_000, async () => {}, () => now);
	assert.equal(ready.pick, next);
});

test("client-error reroutes are capped at three in two minutes (review finding 7)", () => {
	let times: number[] = [];
	for (const t of [0, 1000, 2000]) times = clientReroute(times, t)!;
	assert.equal(clientReroute(times, 3000), undefined);
	assert.ok(clientReroute(times, 2 * MINUTE + 1000), "old reroutes age out");
});

test("a lock is taken over only when stale, and only its owner removes it (review finding 13)", () => {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-own-"));
	const store = new Store(dir);
	const lock = `${store.file}.lock`;
	writeFileSync(lock, "dead-holder");
	const old = (Date.now() - 10_000) / 1000;
	utimesSync(lock, old, old);
	store.update((s) => {
		s.dispatched.x = [1];
	});
	assert.equal(store.load().dispatched.x[0], 1, "a stale lock is taken over");
	assert.equal(existsSync(lock), false, "and released");

	store.update(() => writeFileSync(lock, "someone-else"));
	assert.equal(readFileSync(lock, "utf8"), "someone-else", "a lock it no longer owns is left alone");
	rmSync(dir, { recursive: true, force: true });
});
