import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHelp, renderStatus } from "../src/status.ts";

const input = {
	source: "bundled",
	generated: "2026-10-16T05:58:01Z",
	now: Date.parse("2026-10-16T06:00:00Z"),
	entries: [
		{ rank: 1, model: "ovh/Qwen3.8-27B", availability: { kind: "ready" as const } },
		{
			rank: 2,
			model: "google/gemini-3.8-flash",
			availability: {
				kind: "cooling" as const,
				until: Date.parse("2026-10-16T07:00:00Z"),
				reason: 'daily: 429 {"message":"Daily token quota exceeded","project_id":"private-project"}',
			},
		},
		{
			rank: 3,
			model: "cloudflare-workers-ai/@cf/openai/gpt-oss-120b",
			availability: { kind: "missing-key" as const, provider: "cloudflare-workers-ai" },
		},
		{
			rank: 4,
			model: "cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash",
			availability: { kind: "missing-key" as const, provider: "cloudflare-workers-ai" },
		},
		{
			rank: 5,
			model: "ovh/Qwen3.6-27B",
			availability: { kind: "slow" as const, until: Date.parse("2026-10-16T06:10:00Z") },
		},
		{ rank: 6, model: "missing/model", availability: { kind: "missing-catalog" as const } },
	],
};

test("status groups actionable states and never prints raw provider JSON", () => {
	const output = renderStatus(input);
	assert.match(output, /vazhi · bundled pool · generated 2026-10-16 05:58 UTC/);
	assert.match(output, /1 ready · 1 cooling · 1 slow · 2 need keys · 1 unavailable/);
	assert.match(output, /READY\n\s+01  ovh\/Qwen3\.8-27B/);
	assert.match(output, /daily limit · retry in 1\.0h · Daily token quota exceeded/);
	assert.match(output, /NEEDS A KEY[\s\S]*cloudflare-workers-ai · 2 models · \/login cloudflare-workers-ai/);
	assert.match(output, /SLOW, BUT AVAILABLE[\s\S]*05  ovh\/Qwen3\.6-27B/);
	assert.doesNotMatch(output, /private-project|[{}]/);
	assert.match(output, /Commands: \/vazhi help/);
});

test("all status expands models that need credentials", () => {
	const output = renderStatus({ ...input, all: true });
	assert.match(output, /03  cloudflare-workers-ai\/@cf\/openai\/gpt-oss-120b/);
	assert.match(output, /04  cloudflare-workers-ai\/@cf\/zai-org\/glm-4\.7-flash/);
});

test("help documents every command and configuration location", () => {
	const output = renderHelp();
	for (const command of ["status", "all", "help", "update", "reset"]) assert.match(output, new RegExp(`/vazhi ${command}`));
	assert.match(output, /vazhi\/config\.json/);
	assert.match(output, /exclude.*prefer.*autoUpdate/s);
});
