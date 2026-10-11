import assert from "node:assert/strict";
import { test } from "node:test";
import { kilo, piCatalog, verdict, type Found } from "../scripts/discover.ts";

test("probe verdicts: rate limits are neutral, keyless auth or payment is a failure (review finding 11)", () => {
	assert.equal(verdict(403, '{"error":"rate limit exceeded"}', false), "limited", "403 worded as a rate limit");
	assert.equal(verdict(429, "Too Many Requests", true), "limited");
	assert.equal(verdict(402, "Payment Required", true), "fail", "keyless provider wants payment: not free");
	assert.equal(verdict(401, "Missing API key.", true), "fail", "keyless provider wants a key: not free");
	assert.equal(verdict(401, "invalid api key", false), "limited", "our key's problem, not the model's");
	assert.equal(verdict(400, "quota exceeded for metric ... limit: 0", false), "fail", "Gemini: no free tier");
	assert.equal(verdict(404, "model not found", false), "fail");
});

test("an empty catalog is an error, so the provider keeps its previous rows (review finding 10)", async () => {
	const real = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }))) as typeof fetch;
	try {
		const found: Found = { candidates: [], models: { kilo: [] } };
		await assert.rejects(kilo(found), /empty or malformed/);
	} finally {
		globalThis.fetch = real;
	}
});

test("built-in candidates include pi's live catalog from pi.dev, not just the pinned one", async () => {
	const real = globalThis.fetch;
	try {
		globalThis.fetch = (async (url: string) => {
			assert.match(String(url), /^https:\/\/pi\.dev\/api\/models\/providers\/nvidia\?types=chat$/);
			return new Response(JSON.stringify([{ id: "new/model-added-today" }, { id: "old/bundled" }, { id: "img/x", type: "image" }]));
		}) as typeof fetch;
		assert.deepEqual((await piCatalog("nvidia", { "old/bundled": {} })).sort(), ["new/model-added-today", "old/bundled"]);
		globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
		assert.deepEqual(await piCatalog("nvidia", { "old/bundled": {} }), ["old/bundled"], "pi.dev down: the bundled catalog");
		assert.deepEqual(
			(await piCatalog("nvidia", { "old/bundled": {} }, ["live/only-model"])).sort(),
			["live/only-model", "old/bundled"],
			"pi.dev down: last night's live-only models stay (review of the update change, 3)",
		);
		globalThis.fetch = (async () => new Response("[]")) as unknown as typeof fetch;
		assert.ok((await piCatalog("nvidia", {}, ["live/only-model"])).includes("live/only-model"), "an empty answer counts as a failure");
	} finally {
		globalThis.fetch = real;
	}
});
