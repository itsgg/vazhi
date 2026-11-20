import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { answerText, ask, AskError, callable, HEDGE_AFTER, keyLookup } from "../src/ask.ts";
import { Store } from "../src/router.ts";

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fresh agent dir with a fixed fast list and pool, no downloads, and the given keys. */
function setup(options: { fast?: object[]; pool?: object[]; auth?: object } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-ask-"));
	dirs.push(dir);
	mkdirSync(join(dir, "vazhi"));
	writeFileSync(
		join(dir, "vazhi", "config.json"),
		JSON.stringify({
			autoUpdate: false,
			fast: options.fast ?? [{ model: "groq/a" }, { model: "groq/b" }, { model: "kilo/c:free" }],
			pool: options.pool ?? [{ model: "kilo/p:free" }],
		}),
	);
	writeFileSync(join(dir, "auth.json"), JSON.stringify(options.auth ?? { groq: { type: "api_key", key: "gsk-test" } }));
	return { env: { PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv, store: new Store(join(dir, "vazhi")) };
}

type Reply = { status?: number; body?: unknown; delayMs?: number };

/** A fetch that answers per model id and records what it was asked. */
function fakeFetch(replies: Record<string, Reply>) {
	const calls: { url: string; model: string; headers: Record<string, string>; body: any; aborted: boolean }[] = [];
	const doFetch = (async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		const call = { url, model: body.model, headers: init.headers as Record<string, string>, body, aborted: false };
		calls.push(call);
		const reply = replies[body.model] ?? { status: 500, body: "no reply set" };
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, reply.delayMs ?? 0);
			init.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				call.aborted = true;
				reject(init.signal!.reason ?? new Error("aborted"));
			});
		});
		const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
		return new Response(text, { status: reply.status ?? 200 });
	}) as unknown as typeof fetch;
	return { doFetch, calls };
}

const says = (content: string): Reply => ({ body: { choices: [{ message: { content } }] } });

test("fast: the first model answers, with the key, effort and system prompt it was given", async () => {
	const { env } = setup({ fast: [{ model: "groq/a", effort: "none" }] });
	const { doFetch, calls } = fakeFetch({ a: says("ls -lS") });
	const answer = await ask({ prompt: "biggest files", system: "one command", fast: true, env, fetch: doFetch });
	assert.equal(answer.text, "ls -lS");
	assert.equal(answer.model, "groq/a");
	assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
	assert.equal(calls[0].headers.authorization, "Bearer gsk-test");
	assert.equal(calls[0].body.reasoning_effort, "none");
	assert.deepEqual(calls[0].body.messages, [
		{ role: "system", content: "one command" },
		{ role: "user", content: "biggest files" },
	]);
});

test("a failed model cools down in the state pi shares, and the next model answers", async () => {
	const { env, store } = setup();
	const { doFetch } = fakeFetch({ a: { status: 429, body: "rate limit reached" }, b: says("du -sh *") });
	const answer = await ask({ prompt: "q", fast: true, env, fetch: doFetch });
	assert.equal(answer.model, "groq/b");
	const cooling = store.load().models["groq/a"];
	assert.ok(cooling && cooling.until > Date.now(), "groq/a cools down");
	assert.match(cooling.reason, /^rate/);
});

test("a cooling model is skipped without a request", async () => {
	const { env, store } = setup();
	store.update((s) => {
		s.models["groq/a"] = { until: Date.now() + 60_000, failures: 1, reason: "rate: test", at: Date.now() };
	});
	const { doFetch, calls } = fakeFetch({ a: says("never"), b: says("ok") });
	const answer = await ask({ prompt: "q", fast: true, env, fetch: doFetch });
	assert.equal(answer.model, "groq/b");
	assert.deepEqual(calls.map((c) => c.model), ["b"]);
});

test("fast: a slow first model gets a second one asked after the hedge delay; the loser is not penalized", async () => {
	const { env, store } = setup();
	const { doFetch, calls } = fakeFetch({ a: { ...says("slow"), delayMs: HEDGE_AFTER + 3000 }, b: says("quick") });
	const started = Date.now();
	const answer = await ask({ prompt: "q", fast: true, env, fetch: doFetch });
	assert.equal(answer.text, "quick");
	assert.ok(Date.now() - started < HEDGE_AFTER + 1000, "answered soon after the hedge");
	assert.equal(calls.find((c) => c.model === "a")?.aborted, true, "the slow request is cancelled");
	assert.equal(store.load().models["groq/a"], undefined, "losing a race is not a failure");
});

test("fast: a failure while the hedged model is still answering starts no third model at once", async () => {
	const { env } = setup();
	// a is slow and then fails just after b was started by the hedge; b answers 1 s later.
	const { doFetch, calls } = fakeFetch({
		a: { status: 500, body: "boom", delayMs: HEDGE_AFTER + 100 },
		b: { ...says("from b"), delayMs: 1000 },
		"c:free": says("from c"),
	});
	const answer = await ask({ prompt: "q", fast: true, env, fetch: doFetch });
	assert.equal(answer.text, "from b");
	assert.deepEqual(calls.map((c) => c.model), ["a", "b"], "c is never asked");
});

test("an empty answer moves on without cooling the model", async () => {
	const { env, store } = setup();
	const { doFetch } = fakeFetch({ a: says("  <think>hmm</think>  "), b: says("pwd") });
	const answer = await ask({ prompt: "q", fast: true, env, fetch: doFetch });
	assert.equal(answer.text, "pwd");
	assert.equal(store.load().models["groq/a"], undefined);
});

test("every model failing names each failure", async () => {
	const { env } = setup();
	const { doFetch } = fakeFetch({ a: { status: 500, body: "boom" }, b: { status: 503, body: "down" }, "c:free": { status: 404, body: "gone" } });
	await assert.rejects(ask({ prompt: "q", fast: true, env, fetch: doFetch }), (error: Error) => {
		assert.ok(error instanceof AskError);
		assert.match(error.message, /groq\/a: 500 boom/);
		assert.match(error.message, /kilo\/c:free: 404 gone/);
		return true;
	});
});

test("without keys only keyless providers are asked, with no Authorization header", async () => {
	const { env } = setup({ auth: {} });
	const { doFetch, calls } = fakeFetch({ "c:free": says("ls") });
	const answer = await ask({ prompt: "q", fast: true, env, fetch: doFetch });
	assert.equal(answer.model, "kilo/c:free");
	assert.deepEqual(calls.map((c) => c.model), ["c:free"]);
	assert.equal(calls[0].headers.authorization, undefined);
});

test("no usable model is an AskError before any request", async () => {
	const { env } = setup({ auth: {}, fast: [{ model: "groq/a" }] });
	const { doFetch, calls } = fakeFetch({});
	await assert.rejects(ask({ prompt: "q", fast: true, env, fetch: doFetch }), /no fast-list model has a key/);
	assert.equal(calls.length, 0);
});

test("without --fast it asks the pool, one model at a time", async () => {
	const { env } = setup();
	const { doFetch, calls } = fakeFetch({ "p:free": says("answer") });
	const answer = await ask({ prompt: "q", env, fetch: doFetch });
	assert.equal(answer.model, "kilo/p:free");
	assert.equal(calls.length, 1);
});

test("the caller's abort stops the question", async () => {
	const { env } = setup();
	const { doFetch } = fakeFetch({ a: { ...says("late"), delayMs: 5000 } });
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 50);
	await assert.rejects(ask({ prompt: "q", fast: true, env, fetch: doFetch, signal: controller.signal }), /aborted/);
});

test("keys: auth.json first, then the environment; a shell-command key is not run", () => {
	const { env } = setup({ auth: { groq: { type: "api_key", key: "from-auth" }, google: { type: "api_key", key: "!op read x" } } });
	const key = keyLookup({ ...env, GROQ_API_KEY: "from-env", GEMINI_API_KEY: "gem-env", NVIDIA_API_KEY: "nv-env" });
	assert.equal(key("groq"), "from-auth");
	assert.equal(key("google"), "gem-env");
	assert.equal(key("nvidia"), "nv-env");
	assert.equal(key("openrouter"), undefined);
	assert.equal(callable("cloudflare-workers-ai/@cf/x", () => "k"), false, "no endpoint without an account id");
	assert.equal(callable("ovh/m", () => undefined), true, "keyless provider");
});

test("answer text: string or parts, think blocks removed", () => {
	assert.equal(answerText({ choices: [{ message: { content: "<think>x</think>\nls" } }] }), "ls");
	assert.equal(answerText({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] }), "ab");
	assert.equal(answerText({}), "");
});
