import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { adjustHeaders, retryable, summarizeError } from "../src/index.ts";
import { ANONYMOUS_KEY } from "../src/providers.ts";

const base = {
	role: "assistant",
	content: [],
	api: "openai-completions",
	provider: "llm7",
	model: "m",
	stopReason: "error",
	timestamp: 0,
	usage: {},
} as any;

test("structured provider error.message shapes are summarized without throwing", () => {
	const key = "prov/model";
	const objectMessage = summarizeError(JSON.stringify({ error: { message: { code: "invalid" } } }), key);
	assert.ok(!objectMessage.includes("\n"));
	assert.match(objectMessage, new RegExp(key));
	assert.match(objectMessage, /\{"code":"invalid"\}/);

	const numericMessage = summarizeError(JSON.stringify({ error: { message: 429 } }), key);
	assert.ok(!numericMessage.includes("\n"));
	assert.match(numericMessage, new RegExp(key));
	assert.match(numericMessage, /429/);

	const nullMessage = summarizeError(JSON.stringify({ error: { message: null } }), key);
	assert.ok(!nullMessage.includes("\n"));
	assert.match(nullMessage, new RegExp(key));
	assert.match(nullMessage, /null/);
});

test("quota errors pi would never retry are rewritten into ones it does", () => {
	const quota = { ...base, errorMessage: '429 {"type":"insufficient_quota","message":"quota exceeded"}' };
	const out = retryable(quota, "llm7/m", "daily", 3_600_000);
	assert.ok(out && isRetryableAssistantError(out));
	assert.doesNotMatch(out!.errorMessage!, /quota exceeded/);
});

test("a 404 or 503 error is summarized and becomes retryable with a clean message", () => {
	const out404 = retryable({ ...base, errorMessage: '404 "model does not exist"' }, "kilo/x", "gone", 3_600_000);
	assert.ok(out404 && isRetryableAssistantError(out404) && out404.errorMessage!.startsWith("404"));
	const out503 = retryable({ ...base, errorMessage: "503 Service Unavailable" }, "a/b", "other", 60_000);
	assert.ok(out503 && isRetryableAssistantError(out503) && out503.errorMessage!.startsWith("503"));
});

test("the anonymous placeholder is stripped, a real key is kept", () => {
	const anon: Record<string, string | null> = { Authorization: `Bearer ${ANONYMOUS_KEY}`, "X-Other": "1" };
	adjustHeaders(anon, false);
	assert.equal(anon.Authorization, null);
	assert.equal(anon["X-Other"], "1");
	const real: Record<string, string | null> = { authorization: "Bearer sk-real" };
	adjustHeaders(real, true);
	assert.equal(real.authorization, "Bearer sk-real");
});

test("NVIDIA's poll window is cut from 3600 s to 5 s, so a dead model answers 504 in seconds", () => {
	const h: Record<string, string | null> = { "NVCF-POLL-SECONDS": "3600", Accept: "text/event-stream" };
	adjustHeaders(h, true);
	assert.equal(h["NVCF-POLL-SECONDS"], "5");
	assert.equal(h.Accept, "text/event-stream");
	const lower: Record<string, string | null> = { "nvcf-poll-seconds": "3600" };
	adjustHeaders(lower, true);
	assert.equal(lower["nvcf-poll-seconds"], "5");
	const none: Record<string, string | null> = { Accept: "x" };
	adjustHeaders(none, true);
	assert.deepEqual(none, { Accept: "x" }, "requests without the header are untouched");
	const direct: Record<string, string | null> = { "NVCF-POLL-SECONDS": "3600" };
	adjustHeaders(direct, false);
	assert.equal(direct["NVCF-POLL-SECONDS"], "3600", "a model picked directly has no fallback and keeps the long wait");
});
