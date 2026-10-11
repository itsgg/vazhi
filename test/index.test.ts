import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { retryable, stripAnonymous } from "../src/index.ts";
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

test("quota errors pi would never retry are rewritten into ones it does", () => {
	const quota = { ...base, errorMessage: '429 {"type":"insufficient_quota","message":"quota exceeded"}' };
	const out = retryable(quota, "llm7/m", "daily", 3_600_000);
	assert.ok(out && isRetryableAssistantError(out));
	assert.doesNotMatch(out!.errorMessage!, /quota exceeded/);
});

test("a 404 is tagged and becomes retryable; a 503 is left to pi", () => {
	const out = retryable({ ...base, errorMessage: '404 "model does not exist"' }, "kilo/x", "gone", 3_600_000);
	assert.ok(out && isRetryableAssistantError(out) && out.errorMessage!.startsWith("404"));
	assert.equal(retryable({ ...base, errorMessage: "503 Service Unavailable" }, "a/b", "other", 60_000), undefined);
});

test("the anonymous placeholder is stripped, a real key is kept", () => {
	const anon: Record<string, string | null> = { Authorization: `Bearer ${ANONYMOUS_KEY}`, "X-Other": "1" };
	stripAnonymous(anon);
	assert.equal(anon.Authorization, null);
	assert.equal(anon["X-Other"], "1");
	const real: Record<string, string | null> = { authorization: "Bearer sk-real" };
	stripAnonymous(real);
	assert.equal(real.authorization, "Bearer sk-real");
});
