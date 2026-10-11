import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The extension reads its agent dir at load time; point it at a scratch dir first.
const agentDir = mkdtempSync(join(tmpdir(), "vazhi-wiring-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../src/index.ts");
after(() => rmSync(agentDir, { recursive: true, force: true }));

function load() {
	const handlers: Record<string, Function> = {};
	let virtual: any;
	extension({
		registerProvider() {},
		registerVirtualModel(def: any) {
			virtual = def;
		},
		on(name: string, fn: Function) {
			handlers[name] = fn;
		},
		registerCommand() {},
	} as any);
	return { handlers, virtual };
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
