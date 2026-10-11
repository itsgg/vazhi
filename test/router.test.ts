import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	choose,
	classify,
	clientReroute,
	coolingReason,
	emptyState,
	HOUR,
	MINUTE,
	isGemini3,
	noteStart,
	parseRetryAfter,
	penalize,
	pickWithin,
	recover,
	reserve,
	signatureConstraint,
	Store,
	type Choice,
} from "../src/router.ts";

function childExitWithin(child: ReturnType<typeof spawn>, timeoutMs: number, label: string): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${label} timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			resolve(code);
		});
	});
}

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

test("classify: thought_signature errors are client errors", () => {
	assert.equal(classify("Function call is missing a thought_signature in functionCall parts").kind, "client");
	assert.equal(classify("Function call is missing a thoughtSignature in functionCall parts").kind, "client");
	assert.equal(classify("Thought signature required for function call").kind, "client");
});

test("isGemini3 detects Gemini 3+ models", () => {
	assert.ok(isGemini3("gemini-3.5-flash"));
	assert.ok(isGemini3("gemini-3.8-flash"));
	assert.ok(isGemini3("gemini-live-3.5"));
	assert.ok(!isGemini3("gemini-2.5-flash"));
	assert.ok(!isGemini3("gemini-1.5-pro"));
	assert.ok(!isGemini3("gpt-4"));
	assert.ok(!isGemini3("claude-3-opus"));
});

test("signatureConstraint: no tool calls -> unrestricted", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hi" }] },
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	];
	assert.deepEqual(signatureConstraint(messages), { mode: "unrestricted" });
});

test("signatureConstraint: non-Gemini tool call -> blocked", () => {
	const messages = [
		{ role: "assistant", provider: "nvidia", model: "z-ai/glm-5.3", content: [
			{ type: "toolCall", id: "1", name: "foo", arguments: {} }
		] },
	];
	assert.deepEqual(signatureConstraint(messages), { mode: "blocked" });
});

test("signatureConstraint: single Gemini 3 signed tool call -> pinned to that model", () => {
	const messages = [
		{ role: "assistant", provider: "google", model: "gemini-3.8-flash", content: [
			{ type: "toolCall", id: "1", name: "foo", arguments: {}, thoughtSignature: "YQ==" }
		] },
	];
	assert.deepEqual(signatureConstraint(messages), { mode: "pinned", model: "google/gemini-3.8-flash" });
});

test("signatureConstraint: two different Gemini 3 signers -> blocked", () => {
	const messages = [
		{ role: "assistant", provider: "google", model: "gemini-3.8-flash", content: [
			{ type: "toolCall", id: "1", name: "foo", arguments: {}, thoughtSignature: "YQ==" }
		] },
		{ role: "assistant", provider: "google", model: "gemini-3.6-flash", content: [
			{ type: "toolCall", id: "2", name: "bar", arguments: {}, thoughtSignature: "Yg==" }
		] },
	];
	assert.deepEqual(signatureConstraint(messages), { mode: "blocked" });
});

test("signatureConstraint: invalid signature -> blocked", () => {
	const messages = [
		{ role: "assistant", provider: "google", model: "gemini-3.8-flash", content: [
			{ type: "toolCall", id: "1", name: "foo", arguments: {}, thoughtSignature: "not-base64" }
		] },
	];
	assert.deepEqual(signatureConstraint(messages), { mode: "blocked" });
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

test("Store.load normalizes mixed valid and corrupt nested state", () => {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-store-"));
	const store = new Store(dir);
	writeFileSync(
		store.file,
		JSON.stringify({
			models: {
				"good/a": { until: 5_000, failures: 2, reason: "rate: x", at: 100 },
				"bad/a": { until: "not-finite", failures: 1, reason: "x", at: 0 },
				"bad/b": { until: 1, failures: 1, at: 0 },
			},
			providers: {
				good: { until: 3_000, failures: 1, reason: "auth: x", at: 50 },
				bad: { until: 1, failures: "nope", reason: "x", at: 0 },
			},
			lastLimit: {
				good: { at: 200, model: "kilo/a" },
				badAt: { at: "NaN", model: "kilo/b" },
				badModel: { at: 300, model: 42 },
			},
			dispatched: {
				"good/rpm": [1_000, 2_000, "skip", null, Number.POSITIVE_INFINITY],
				"bad/rpm": 7,
			},
			slow: {
				"good/slow": 9_000,
				"bad/slow": "not-a-number",
				"bad/inf": "Infinity",
			},
		}),
	);
	const state = store.load();
	assert.deepEqual(state.models["good/a"], { until: 5_000, failures: 2, reason: "rate: x", at: 100 });
	assert.deepEqual(state.providers.good, { until: 3_000, failures: 1, reason: "auth: x", at: 50 });
	assert.deepEqual(state.lastLimit.good, { at: 200, model: "kilo/a" });
	assert.deepEqual(state.dispatched["good/rpm"], [1_000, 2_000]);
	assert.equal(state.slow["good/slow"], 9_000);

	const pool = [
		{ model: "good/a" },
		{ model: "good/rpm", rpm: 2 },
		{ model: "bad/rpm", rpm: 2 },
		{ model: "other/x" },
	];
	const now = 2_500;
	assert.doesNotThrow(() => choose(pool, state, now));
	assert.doesNotThrow(() => reserve(state, pool[1], now));
	assert.doesNotThrow(() => coolingReason(state, pool[0], now));
	assert.doesNotThrow(() => coolingReason(state, pool[1], now));

	assert.equal(state.models["bad/a"], undefined);
	assert.equal(state.models["bad/b"], undefined);
	assert.equal(state.providers.bad, undefined);
	assert.equal(state.lastLimit.badAt, undefined);
	assert.equal(state.lastLimit.badModel, undefined);
	assert.equal(state.dispatched["bad/rpm"], undefined);
	assert.equal(state.slow["bad/slow"], undefined);
	assert.equal(state.slow["bad/inf"], undefined);

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

async function assertOrphanedClaimRecovered(lockExists: boolean): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-orphaned-claim-"));
	const stateFile = join(dir, "state.json");
	const lock = `${stateFile}.lock`;
	const claim = `${lock}.claim`;
	const worker = join(dir, "update.mts");
	const router = fileURLToPath(new URL("../src/router.ts", import.meta.url));
	writeFileSync(lock, "dead-owner");
	const old = (Date.now() - 10_000) / 1000;
	utimesSync(lock, old, old);
	linkSync(lock, claim);
	if (!lockExists) unlinkSync(lock);
	writeFileSync(
		worker,
		`const { Store } = await import(${JSON.stringify(router)});\n` +
			`new Store(${JSON.stringify(dir)}).update((state) => { state.dispatched.recovered = [1]; });\n`,
	);
	const child = spawn(process.execPath, [worker], { stdio: "inherit" });
	try {
		assert.equal(await childExitWithin(child, 2_000, "orphaned claim recovery"), 0);
		assert.equal(new Store(dir).load().dispatched.recovered[0], 1);
		assert.equal(existsSync(lock), false);
		assert.equal(existsSync(claim), false);
	} finally {
		child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
}

test("an orphaned claim with its stale lock cannot deadlock updates", async () => {
	await assertOrphanedClaimRecovered(true);
});

test("an orphaned claim after its lock was removed cannot deadlock release", async () => {
	await assertOrphanedClaimRecovered(false);
});

test("unsupported hard links fall back without leaking a stale lock", async () => {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-link-fallback-"));
	const stateFile = join(dir, "state.json");
	const lock = `${stateFile}.lock`;
	const claim = `${lock}.claim`;
	const worker = join(dir, "update.mts");
	const routerUrl = new URL("../src/router.ts", import.meta.url);
	writeFileSync(lock, "dead-owner");
	const old = (Date.now() - 10_000) / 1000;
	utimesSync(lock, old, old);
	writeFileSync(
		worker,
		`import fs from "node:fs";\n` +
			`import { syncBuiltinESMExports } from "node:module";\n` +
			`fs.linkSync = () => { const error = new Error("unsupported hard link"); error.code = "EPERM"; throw error; };\n` +
			`syncBuiltinESMExports();\n` +
			`const { Store } = await import(${JSON.stringify(routerUrl.href)} + "?unsupported-link");\n` +
			`new Store(${JSON.stringify(dir)}).update((state) => { state.dispatched.fallback = [1]; });\n`,
	);
	const child = spawn(process.execPath, [worker], { stdio: "inherit" });
	try {
		assert.equal(await childExitWithin(child, 2_000, "unsupported-link fallback"), 0);
		assert.equal(new Store(dir).load().dispatched.fallback[0], 1);
		assert.equal(existsSync(lock), false);
		assert.equal(existsSync(claim), false);
	} finally {
		child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stale cleanup cannot delete a replacement lock", { timeout: 10_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-replacement-"));
	const stateFile = join(dir, "state.json");
	const lock = `${stateFile}.lock`;
	const claim = `${lock}.claim`;
	const trigger = join(dir, "replace");
	const replacementReady = join(dir, "replacement-ready");
	const nextInspection = join(dir, "next-inspection");
	const outcome = join(dir, "outcome");
	const token = "fresh-owner";
	const worker = join(dir, "replacement-owner.mts");
	writeFileSync(lock, "stale-owner");
	const old = (Date.now() - 10_000) / 1000;
	utimesSync(lock, old, old);
	writeFileSync(
		worker,
		`import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";\n` +
			`const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);\n` +
			`let deadline = Date.now() + 2_000;\n` +
			`while (!existsSync(${JSON.stringify(trigger)})) {\n` +
			`  if (Date.now() >= deadline) throw new Error("replacement trigger timed out");\n` +
			`  sleep();\n` +
			`}\n` +
			`unlinkSync(${JSON.stringify(lock)});\n` +
			`writeFileSync(${JSON.stringify(lock)}, ${JSON.stringify(token)}, { flag: "wx" });\n` +
			`writeFileSync(${JSON.stringify(replacementReady)}, "");\n` +
			`deadline = Date.now() + 2_000;\n` +
			`for (;;) {\n` +
			`  let current;\n` +
			`  try { current = readFileSync(${JSON.stringify(lock)}, "utf8"); } catch { current = undefined; }\n` +
			`  if (current !== ${JSON.stringify(token)}) { writeFileSync(${JSON.stringify(outcome)}, "deleted"); break; }\n` +
			`  if (existsSync(${JSON.stringify(nextInspection)})) {\n` +
			`    unlinkSync(${JSON.stringify(lock)});\n` +
			`    writeFileSync(${JSON.stringify(outcome)}, "released");\n` +
			`    break;\n` +
			`  }\n` +
			`  if (Date.now() >= deadline) {\n` +
			`    unlinkSync(${JSON.stringify(lock)});\n` +
			`    writeFileSync(${JSON.stringify(outcome)}, "handshake-timeout");\n` +
			`    throw new Error("next inspection timed out");\n` +
			`  }\n` +
			`  sleep();\n` +
			`}\n`,
	);
	const child = spawn(process.execPath, [worker], { stdio: "inherit" });
	const childExit = childExitWithin(child, 5_000, "replacement owner");
	const originalStatSync = fs.statSync;
	const mutableFs = fs as { statSync: typeof fs.statSync };
	let inspections = 0;
	mutableFs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
		const path = String(args[0]);
		if (path !== lock && path !== claim) return Reflect.apply(originalStatSync, fs, args);
		inspections++;
		const inspected = Reflect.apply(originalStatSync, fs, args);
		if (inspections === 1) {
			writeFileSync(trigger, "");
			const deadline = Date.now() + 5_000;
			while (!existsSync(replacementReady)) {
				if (Date.now() >= deadline) throw new Error("replacement owner did not acquire the lock");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
			}
		} else if (inspections === 2) {
			writeFileSync(nextInspection, "");
		}
		return inspected;
	}) as typeof fs.statSync;
	syncBuiltinESMExports();

	try {
		const routerUrl = new URL("../src/router.ts", import.meta.url);
		routerUrl.searchParams.set("replacement-race", String(Date.now()));
		const { Store: RaceStore } = (await import(routerUrl.href)) as typeof import("../src/router.ts");
		const store = new RaceStore(dir);
		store.update((state) => {
			state.dispatched.race = [1];
		});
		assert.equal(await childExit, 0);
		assert.equal(readFileSync(outcome, "utf8"), "released", "the fresh owner releases its own lock");
		assert.equal(store.load().dispatched.race[0], 1, "the waiting update completes");
		assert.equal(existsSync(lock), false);
		assert.equal(existsSync(claim), false);
	} finally {
		mutableFs.statSync = originalStatSync;
		syncBuiltinESMExports();
		child.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slow starters go behind faster models but still serve when nothing else is ready", () => {
	const a = { model: "nvidia/slow" };
	const b = { model: "kilo/fast" };
	const s = emptyState();
	noteStart(s, "nvidia/slow", 32_000, 0);
	assert.equal(choose([a, b], s, 1000).pick, b, "the faster model goes first");
	assert.equal(choose([a, b], s, 1000, "nvidia/slow").pick, b, "even mid-turn, when a faster one is ready");
	assert.equal(choose([a], s, 1000).pick, a, "a slow model beats no model");
	s.models["kilo/fast"] = { until: 99_000, failures: 1, reason: "x", at: 0 };
	assert.equal(choose([a, b], s, 1000).pick, a, "and serves when the fast one is cooling");
	delete s.models["kilo/fast"];
	noteStart(s, "nvidia/slow", 1_500, 2000);
	assert.ok(s.slow["nvidia/slow"] > 2000, "a fast start does not clear the mark early (no flapping)");
	assert.equal(choose([a, b], s, 2000).pick, b);
	assert.equal(choose([a, b], s, 11 * MINUTE).pick, a, "the mark wears off at its deadline");
	noteStart(s, "kilo/fast", 15_000, 11 * MINUTE);
	assert.equal(s.slow["kilo/fast"], undefined, "exactly 15 s is not slower than 15 s");
	assert.equal(s.slow["nvidia/slow"], undefined, "expired marks are pruned");
});

test("NVIDIA's 504 for a model it cannot serve cools like a hang: 15 minutes, then 30", () => {
	const s = emptyState();
	assert.equal(penalize(s, "nvidia/z-ai/glm-5.3", "504 status code (no body)", 0), 15 * MINUTE);
	assert.equal(penalize(s, "nvidia/z-ai/glm-5.3", "504 status code (no body)", 0), 30 * MINUTE);
});

test("only NVIDIA's leading 504 counts as a hang (review findings)", () => {
	assert.equal(classify("504 status code (no body)", "nvidia").kind, "slow");
	assert.equal(classify("504 Gateway Timeout", "kilo").kind, "slow", "worded as a timeout, so a hang anyway");
	assert.equal(classify("504 status code (no body)", "kilo").kind, "other", "another provider's bare 504 may be a blip");
	assert.equal(classify("429 Too Many Requests. Retry-After: 504", "nvidia").kind, "rate", "a 504 later in the text is not the status");
	assert.equal(classify("400 prompt has 504 tokens too many fields", "nvidia").kind, "client");
	assert.equal(penalize(emptyState(), "kilo/x:free", "504 status code (no body)", 0), MINUTE);
});
