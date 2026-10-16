import assert from "node:assert/strict";
import { test } from "node:test";
import { modelAvailability } from "../src/models.ts";
import { emptyState, HOUR, type PoolEntry, type SignatureConstraint } from "../src/router.ts";

const entry: PoolEntry = { model: "google/gemini-3.8-flash" };
const unrestricted: SignatureConstraint = { mode: "unrestricted" };
const registry = (found = true, authenticated = true) => ({
	find: () => (found ? { provider: "google", id: "gemini-3.8-flash" } : undefined),
	hasConfiguredAuth: () => authenticated,
});

test("model availability distinguishes missing catalog and credentials", () => {
	assert.deepEqual(modelAvailability(entry, emptyState(), 100, registry(false), unrestricted), { kind: "missing-catalog" });
	assert.deepEqual(modelAvailability(entry, emptyState(), 100, registry(true, false), unrestricted), {
		kind: "missing-key",
		provider: "google",
	});
});

test("model availability applies thought-signature compatibility", () => {
	assert.deepEqual(modelAvailability(entry, emptyState(), 100, registry(), { mode: "blocked" }), {
		kind: "incompatible",
		reason: "Gemini thought signature belongs to another model",
	});
	assert.deepEqual(
		modelAvailability(entry, emptyState(), 100, registry(), { mode: "pinned", model: "google/gemini-3.6-flash" }),
		{ kind: "incompatible", reason: "conversation is signed for google/gemini-3.6-flash" },
	);
});

test("model availability reports cooling, slow, and ready states", () => {
	const now = 1_000;
	const cooling = emptyState();
	cooling.models[entry.model] = { until: now + HOUR, failures: 1, reason: "daily: quota exceeded", at: now } as any;
	assert.deepEqual(modelAvailability(entry, cooling, now, registry(), unrestricted), {
		kind: "cooling",
		until: now + HOUR,
		reason: "daily: quota exceeded",
	});

	const slow = emptyState();
	slow.slow[entry.model] = now + HOUR;
	assert.deepEqual(modelAvailability(entry, slow, now, registry(), unrestricted), { kind: "slow", until: now + HOUR });
	assert.deepEqual(modelAvailability(entry, emptyState(), now, registry(), unrestricted), { kind: "ready" });
});
