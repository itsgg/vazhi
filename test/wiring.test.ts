import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The extension reads its agent dir when loaded: each test gets a fresh one, and no network.
const dirs: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("no network in tests", { status: 503 })) as unknown as typeof fetch;
const { default: extension } = await import("../src/index.ts");
after(() => {
	globalThis.fetch = realFetch;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function load(options?: {
	pool?: { model: string }[];
	experiments?: {
		observations?: boolean;
		stickiness?: "current" | "strict";
		cleanRetry?: boolean;
		repoMap?: boolean;
		taskClass?: { bugfix?: string; edit?: string; answer?: string };
	};
}) {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-wiring-"));
	dirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	if (options?.pool || options?.experiments) {
		const vazhi = join(dir, "vazhi");
		mkdirSync(vazhi, { recursive: true });
		writeFileSync(join(vazhi, "config.json"), JSON.stringify({ ...(options.pool ? { pool: options.pool } : {}), ...(options.experiments ? { experiments: options.experiments } : {}), autoUpdate: false }));
	}
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	const registered: Record<string, string[]>[] = [];
	let virtual: any;
	extension({
		registerProvider(id: string, config: any) {
			registered.push({ [id]: (config.models ?? []).map((m: any) => m.id) });
		},
		registerVirtualModel(def: any) {
			virtual = def;
		},
		on(name: string, fn: Function) {
			handlers[name] = fn;
		},
		registerCommand(name: string, options: any) {
			commands[name] = options;
		},
	} as any);
	return { handlers, virtual, registered, commands };
}

const ctx = {
	model: { provider: "vazhi", id: "auto" },
	hasUI: false,
	modelRegistry: { find: () => ({ contextWindow: 128000 }), hasConfiguredAuth: () => true },
};

test("a failure from a model a pool update removed still reroutes (review finding 2)", () => {
	const { handlers } = load();
	const message = {
		role: "assistant",
		provider: "kilo",
		model: "gone-since-the-update:free",
		stopReason: "error",
		errorMessage: '404 "model does not exist"',
		timestamp: Date.now(),
		content: [],
	};
	const out = handlers.message_end({ type: "message_end", message }, ctx);
	assert.match(out?.message?.errorMessage ?? "", /vazhi: service unavailable, rerouting/);
});

test("route: incompatible tool history skips Gemini 3 for the next model in pool order", async () => {
	const { virtual } = load({
		pool: [{ model: "google/gemini-3.8-flash" }, { model: "kilo/sig-fallback:free" }],
	});
	const routeCtx = {
		...ctx,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
		},
	};
	const messages = [
		{
			role: "assistant",
			provider: "nvidia",
			model: "z-ai/glm-5.3",
			content: [{ type: "toolCall", id: "1", name: "foo", arguments: {} }],
		},
	];
	const route = await virtual.route({ reason: "user", thinkingLevel: "medium", messages }, routeCtx);
	assert.equal(`${route.model.provider}/${route.model.id}`, "kilo/sig-fallback:free");
});

test("route: all incompatible candidates advise a new session or a non-Gemini-3 model", async () => {
	const { virtual } = load({ pool: [{ model: "google/gemini-3.8-flash" }] });
	const routeCtx = {
		...ctx,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
		},
	};
	const messages = [
		{
			role: "assistant",
			provider: "nvidia",
			model: "z-ai/glm-5.3",
			content: [{ type: "toolCall", id: "1", name: "foo", arguments: {} }],
		},
	];
	await assert.rejects(
		virtual.route({ reason: "user", thinkingLevel: "medium", messages }, routeCtx),
		{
			message:
				"vazhi: no pool model matches Gemini thought-signature compatibility for this conversation; start a new session or add a non-Gemini-3 model to the pool",
		},
	);
});

test("route: signed Gemini conversation stays on that exact model", async () => {
	const { virtual } = load({
		pool: [
			{ model: "google/gemini-3.6-flash" },
			{ model: "google/gemini-3.8-flash" },
			{ model: "kilo/sig-fallback:free" },
		],
	});
	const routeCtx = {
		...ctx,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
		},
	};
	const messages = [
		{
			role: "assistant",
			provider: "google",
			model: "gemini-3.8-flash",
			content: [{ type: "toolCall", id: "1", name: "foo", arguments: {}, thoughtSignature: "YQ==" }],
		},
	];
	const route = await virtual.route({ reason: "user", thinkingLevel: "medium", messages }, routeCtx);
	assert.equal(`${route.model.provider}/${route.model.id}`, "google/gemini-3.8-flash");
});

test("route picks a fresh model each attempt and returns the first ready one", async () => {
	const { virtual } = load();
	const models = new Map<string, any>();
	const routeCtx = {
		...ctx,
		modelRegistry: {
			find: (provider: string, id: string) => {
				const key = `${provider}/${id}`;
				if (!models.has(key)) models.set(key, { provider, id });
				return models.get(key);
			},
			hasConfiguredAuth: () => true,
		},
	};
	const route = await virtual.route({ reason: "user", thinkingLevel: "medium", messages: [] }, routeCtx);
	assert.ok(route.model.provider && route.model.id, "a physical model");
});

test("each new turn checks for the nightly pool, with one download at a time", async () => {
	const { virtual } = load();
	const stub = globalThis.fetch;
	let calls = 0;
	let release!: () => void;
	globalThis.fetch = (async () => {
		calls++;
		await new Promise<void>((r) => (release = r));
		return new Response("unavailable", { status: 503 });
	}) as unknown as typeof fetch;
	try {
		const routeCtx = { ...ctx, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true } };
		await virtual.route({ reason: "user", thinkingLevel: "medium", messages: [] }, routeCtx);
		await virtual.route({ reason: "user", thinkingLevel: "medium", messages: [] }, routeCtx);
		await virtual.route({ reason: "continuation", thinkingLevel: "medium", messages: [] }, routeCtx);
		assert.equal(calls, 1, "two turns while one download is in flight start one download");
		release();
		await new Promise((r) => setTimeout(r, 20));
		await virtual.route({ reason: "user", thinkingLevel: "medium", messages: [] }, routeCtx);
		assert.equal(calls, 1, "after the failure it waits an hour, not every turn");
	} finally {
		globalThis.fetch = stub;
	}
});

test("a pool downloaded mid-turn takes effect at the next turn (review of the update change, 1)", async () => {
	const { virtual, registered } = load();
	const stub = globalThis.fetch;
	const newer = {
		version: 1,
		generated: "2999-01-01T00:00:00Z",
		sharedLimits: [],
		models: { kilo: [{ id: "brand/new:free", name: "New", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 32768 }] },
		pool: [{ model: "kilo/brand/new:free" }],
	};
	globalThis.fetch = (async () => new Response(JSON.stringify(newer))) as unknown as typeof fetch;
	try {
		const seen: string[] = [];
		const routeCtx = {
			...ctx,
			modelRegistry: {
				find: (provider: string, id: string) => (seen.push(`${provider}/${id}`), { provider, id }),
				hasConfiguredAuth: () => true,
			},
		};
		const before = registered.length;
		await virtual.route({ reason: "user", thinkingLevel: "medium", messages: [] }, routeCtx);
		await new Promise((r) => setTimeout(r, 20)); // the download lands mid-turn
		seen.length = 0;
		await virtual.route({ reason: "continuation", thinkingLevel: "medium", messages: [] }, routeCtx);
		assert.equal(registered.length, before, "no provider re-registration inside the turn");
		assert.ok(!seen.includes("kilo/brand/new:free"), "the turn keeps its pool");
		const next = await virtual.route({ reason: "user", thinkingLevel: "medium", messages: [] }, routeCtx);
		assert.ok(registered.length > before, "providers re-registered at the next turn");
		assert.ok(registered.some((r) => r.kilo?.includes("brand/new:free")));
		assert.equal(`${next.model.provider}/${next.model.id}`, "kilo/brand/new:free", "the next turn routes with the new pool");
	} finally {
		globalThis.fetch = stub;
	}
});

test("the working line names the model being asked, and resets when the turn ends", async () => {
	const { virtual, handlers } = load();
	const messages: (string | undefined)[] = [];
	const uiCtx = {
		...ctx,
		hasUI: true,
		ui: { setWorkingMessage: (m?: string) => messages.push(m), notify() {} },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
	};
	const route = await virtual.route({ reason: "user", thinkingLevel: "medium", messages: [] }, uiCtx);
	assert.equal(messages.at(-1), `Working... (vazhi: ${route.model.id} on ${route.model.provider})`);
	handlers.agent_end({ type: "agent_end", messages: [] }, uiCtx);
	assert.equal(messages.at(-1), undefined, "default working message restored");
});

test("a response whose first token came late marks its model slow; start events do not count", () => {
	const { handlers } = load();
	const state = () => JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "vazhi", "state.json"), "utf8"));
	const fast = { role: "assistant", provider: "kilo", model: "a:free", stopReason: "stop", timestamp: Date.now() - 20_000, content: [] };
	handlers.message_update({ type: "message_update", message: fast, assistantMessageEvent: { type: "text_start" } }, ctx);
	handlers.message_end({ type: "message_end", message: fast }, ctx);
	assert.equal(state().slow["kilo/a:free"], undefined, "no delta, no first-token time, no mark");

	const slow = { role: "assistant", provider: "nvidia", model: "z-ai/glm-5.3-flash", stopReason: "stop", timestamp: Date.now() - 20_000, content: [] };
	handlers.message_update({ type: "message_update", message: slow, assistantMessageEvent: { type: "text_delta" } }, ctx);
	handlers.message_end({ type: "message_end", message: slow }, ctx);
	assert.ok(state().slow["nvidia/z-ai/glm-5.3-flash"] > Date.now(), "20 s to the first delta is slow");
});

test("NVIDIA's poll window is shortened only while vazhi routes", () => {
	const { handlers } = load();
	const routed: Record<string, string | null> = { "NVCF-POLL-SECONDS": "3600" };
	handlers.before_provider_headers({ type: "before_provider_headers", headers: routed }, ctx);
	assert.equal(routed["NVCF-POLL-SECONDS"], "5");
	const direct: Record<string, string | null> = { "NVCF-POLL-SECONDS": "3600" };
	handlers.before_provider_headers({ type: "before_provider_headers", headers: direct }, { ...ctx, model: { provider: "nvidia", id: "x" } });
	assert.equal(direct["NVCF-POLL-SECONDS"], "3600");
});

test("/vazhi renders grouped status, help, and useful unknown-command guidance", async () => {
	const { commands } = load({ pool: [{ model: "kilo/ready:free" }, { model: "openrouter/key:free" }] });
	const notices: string[] = [];
	const commandCtx = {
		...ctx,
		ui: { notify: (message: string) => notices.push(message) },
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: (model: any) => model.provider === "kilo",
		},
	};
	await commands.vazhi.handler("", commandCtx);
	assert.match(notices.at(-1) ?? "", /READY[\s\S]*kilo\/ready:free/);
	assert.match(notices.at(-1) ?? "", /NEEDS A KEY[\s\S]*openrouter · 1 model/);
	await commands.vazhi.handler("help", commandCtx);
	assert.match(notices.at(-1) ?? "", /\/vazhi all/);
	await commands.vazhi.handler("wat", commandCtx);
	assert.match(notices.at(-1) ?? "", /Unknown vazhi command "wat"/);
});

test("a repeated unsupported claim is stored without another continuation", () => {
	const { handlers } = load();
	const notices: string[] = [];
	const settleCtx = { ...ctx, hasUI: true, ui: { notify: (message: string) => notices.push(message), setWorkingMessage() {} }, cwd: "/tmp" };
	const event = {
		type: "agent_before_settle",
		outcome: "completed",
		context: { contextMessages: [{ role: "assistant", content: [{ type: "text", text: "All tests pass." }] }] },
	};
	handlers.agent_start();
	const first = handlers.agent_before_settle(event, settleCtx);
	assert.equal(first.continue, true);
	const second = handlers.agent_before_settle(event, settleCtx);
	assert.equal(second?.continue, undefined);
	assert.equal(second.entries[0].customType, "vazhi-unverified");
	assert.match(notices.at(-1) ?? "", /unverified: test/);
});

test("strict stickiness keeps a slow model and a task-class table can move another model first", async () => {
	const routeCtx = {
		...ctx,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
		},
	};
	const sticky = load({ pool: [{ model: "nvidia/slow" }, { model: "kilo/fast" }], experiments: { stickiness: "strict" } });
	writeFileSync(
		join(process.env.PI_CODING_AGENT_DIR!, "vazhi", "state.json"),
		JSON.stringify({ models: {}, providers: {}, lastLimit: {}, dispatched: {}, slow: { "nvidia/slow": Date.now() + 60_000 } }),
	);
	const stayed = await sticky.virtual.route(
		{ reason: "continuation", thinkingLevel: "medium", messages: [], previous: { model: { provider: "nvidia", id: "slow" } } },
		routeCtx,
	);
	assert.equal(stayed.model.id, "slow");
	const switched = load({ pool: [{ model: "nvidia/slow" }, { model: "kilo/fast" }] });
	writeFileSync(
		join(process.env.PI_CODING_AGENT_DIR!, "vazhi", "state.json"),
		JSON.stringify({ models: {}, providers: {}, lastLimit: {}, dispatched: {}, slow: { "nvidia/slow": Date.now() + 60_000 } }),
	);
	const moved = await switched.virtual.route(
		{ reason: "continuation", thinkingLevel: "medium", messages: [], previous: { model: { provider: "nvidia", id: "slow" } } },
		routeCtx,
	);
	assert.equal(moved.model.id, "fast");
	const classified = load({
		pool: [{ model: "ovh/first" }, { model: "kilo/second" }],
		experiments: { taskClass: { bugfix: "kilo/second" } },
	});
	const bugfix = await classified.virtual.route(
		{ reason: "user", thinkingLevel: "medium", messages: [{ role: "user", content: "The tests fail. Fix them." }] },
		routeCtx,
	);
	assert.equal(`${bugfix.model.provider}/${bugfix.model.id}`, "kilo/second");
});

test("clean retry records the failed check and does not continue", () => {
	const { handlers } = load({ experiments: { cleanRetry: true } });
	const event = {
		type: "agent_before_settle",
		outcome: "completed",
		context: { contextMessages: [{ role: "assistant", content: [{ type: "text", text: "All tests pass." }] }] },
	};
	handlers.agent_start();
	const first = handlers.agent_before_settle(event, { ...ctx, hasUI: false, cwd: "/tmp" });
	assert.equal(first.continue, undefined);
	assert.equal(first.entries[0].customType, "vazhi-clean-retry");
	assert.match(first.entries[0].content, /new session/);
});

test("repository signatures are appended only when the experiment is on", () => {
	const cwd = mkdtempSync(join(tmpdir(), "vazhi-map-wire-"));
	dirs.push(cwd);
	writeFileSync(join(cwd, "sample.py"), "def alpha():\n    return 1\n");
	const event = { type: "before_agent_start", systemPrompt: "base", prompt: "hi" };
	assert.equal(load().handlers.before_agent_start(event, { ...ctx, cwd }), undefined);
	const on = load({ experiments: { repoMap: true } }).handlers.before_agent_start(event, { ...ctx, cwd });
	assert.match(on.systemPrompt, /^base\n\nRepository signatures:\n[\s\S]*sample\.py: def alpha/);
});

test("observation windowing is off until the experiment is enabled", () => {
	const messages = Array.from({ length: 6 }, (_, i) => ({ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: `output ${i}` }] }));
	const off = load().handlers.context({ type: "context", messages }, ctx);
	assert.equal(off, undefined);
	const on = load({ experiments: { observations: true } }).handlers.context({ type: "context", messages }, ctx);
	assert.match(on.messages[0].content[0].text, /collapsed/);
	assert.equal(messages[0].content[0].text, "output 0");
});
