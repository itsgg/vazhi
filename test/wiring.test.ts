import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

function load() {
	const dir = mkdtempSync(join(tmpdir(), "vazhi-wiring-"));
	dirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	const handlers: Record<string, Function> = {};
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
		registerCommand() {},
	} as any);
	return { handlers, virtual, registered };
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
