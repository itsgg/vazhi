import assert from "node:assert/strict";
import { test } from "node:test";
import { formatFailure, normalizeFailure } from "../src/errors.ts";

test("normalizes nested provider JSON to one concise message", () => {
	const raw = JSON.stringify({
		error: {
			message: JSON.stringify({
				error: { code: 503, message: "This model is currently experiencing high demand." },
			}),
		},
	});
	assert.deepEqual(normalizeFailure(raw, "google"), {
		kind: "other",
		status: 503,
		message: "This model is currently experiencing high demand.",
		scope: "model",
	});
});

test("normalizes retry delay and classifies quota scope", () => {
	const failure = normalizeFailure(
		'429 {"message":"Daily token quota exceeded. Retry after 80600 seconds","project_id":"project-secret"}',
		"llm7",
	);
	assert.equal(failure.kind, "daily");
	assert.equal(failure.status, 429);
	assert.equal(failure.retryAfterMs, 80_600_000);
	assert.equal(failure.scope, "model");
	assert.doesNotMatch(failure.message, /project-secret/);
});

test("redacts identifiers and bearer tokens from unknown error shapes", () => {
	const failure = normalizeFailure(
		'failure for account_id="acct-private-123" project/123456 Bearer secret.token-value',
		"other",
	);
	assert.doesNotMatch(failure.message, /acct-private|123456|secret\.token/);
});

test("formats a bounded human-readable failure without raw JSON", () => {
	const text = formatFailure(
		normalizeFailure('503 {"error":{"message":"Service unavailable because the free workers are busy"}}', "cloudflare-workers-ai"),
	);
	assert.equal(text, "503 provider unavailable · Service unavailable because the free workers are busy");
	assert.doesNotMatch(text, /[{}]/);
});

test("an empty or malformed body still gets a useful summary", () => {
	assert.equal(formatFailure(normalizeFailure("", "kilo")), "provider error");
	assert.equal(formatFailure(normalizeFailure("{broken", "kilo")), "provider unavailable · {broken");
});
