import assert from "node:assert/strict";
import { test } from "node:test";
import { kilo, verdict, type Found } from "../scripts/discover.ts";

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
