import assert from "node:assert/strict";
import { test } from "node:test";
import { appendHistory, family, rank, status, type History } from "../scripts/rank.ts";

test("family gives one name per model across providers and AA slugs", () => {
	const same: string[][] = [
		["Qwen3.5-397B-A17B", "qwen3-5-397b-a17b", "qwen/qwen3.5-397b-a17b:free"],
		["nvidia/nemotron-3-ultra-550b-a55b", "nemotron-3-ultra", "nvidia/nemotron-3-ultra-550b-a55b:free"],
		["gemma4:31b", "google/gemma-4-31b-it"],
		["gpt-oss:120b", "openai/gpt-oss-120b", "gpt-oss-120b-high"],
		["deepseek-v4-pro:0813", "deepseek-v4-pro"],
		["DeepSeek-V4-Flash-0731", "deepseek-v4-flash"],
		["z-ai/glm-5.3-flash", "glm-5-3-flash", "@cf/zai-org/glm-5.3-flash"],
	];
	for (const group of same) assert.equal(new Set(group.map(family)).size, 1, group.join(", "));
	assert.notEqual(family("gpt-oss-120b"), family("gpt-oss-20b"));
	assert.notEqual(family("glm-5.3"), family("glm-5.3-flash"));
});

test("status: a pass is ok, one blip is forgiven, two failures or an unproven failure is down", () => {
	const h = (...results: ("ok" | "fail" | "limited")[]) => results.map((result) => ({ at: "", result }));
	assert.equal(status(undefined), "unverified");
	assert.equal(status(h("limited")), "unverified");
	assert.equal(status(h("ok", "fail")), "ok");
	assert.equal(status(h("ok", "fail", "limited", "fail")), "down");
	assert.equal(status(h("fail")), "down");
	assert.equal(status(h("fail", "fail", "ok")), "ok");
});

test("rank: quality times capacity, eval adjusts, down models last, ovh paced", () => {
	const history: History = {
		"nvidia/z-ai/glm-5.3": [{ at: "", result: "fail" }, { at: "", result: "fail" }],
		"nvidia/z-ai/glm-5.3-flash": [{ at: "", result: "ok" }],
		"nvidia/nvidia/nemotron-3-ultra-550b-a55b": [{ at: "", result: "ok" }],
		"google/gemini-3.8-flash": [{ at: "", result: "ok" }],
		"ovh/Qwen3.8-27B": [{ at: "", result: "ok" }],
	};
	const seeds = { "glm-5-3": 50, "glm-5-3-flash": 46, "nemotron-3-ultra": 40, "gemini-3-8-flash": 48, "qwen-3-8-27b": 42 };
	const candidates = Object.keys(history).map((model) => ({ model, probed: true }));
	const now = new Date("2026-10-11T00:00:00Z");
	const ranked = rank(candidates, { history, aa: {}, seeds, evals: {}, now });
	assert.deepEqual(
		ranked.map((r) => r.model),
		[
			"nvidia/z-ai/glm-5.3-flash", // 46
			"nvidia/nvidia/nemotron-3-ultra-550b-a55b", // 40
			"google/gemini-3.8-flash", // 48 x 0.8
			"ovh/Qwen3.8-27B", // 42 x 0.85
		],
		"nvidia/z-ai/glm-5.3 has the best quality but is down, so it is left out (review finding 8)",
	);
	assert.equal(ranked.find((r) => r.model === "ovh/Qwen3.8-27B")?.rpm, 2);

	const evals = { "nvidia/z-ai/glm-5.3-flash": { passed: 0, total: 3, at: "2026-10-10T00:00:00Z" } };
	const withEval = rank(candidates, { history, aa: {}, seeds, evals, now });
	assert.equal(withEval[0].model, "nvidia/nvidia/nemotron-3-ultra-550b-a55b", "a failed eval demotes");

	const aa = { "nemotron-3-ultra": 60 };
	assert.equal(rank(candidates, { history, aa, seeds, evals: {}, now })[0].model, "nvidia/nvidia/nemotron-3-ultra-550b-a55b", "AA beats seeds");
});

test("status comes from history even when CI could not probe tonight (review finding 9)", () => {
	const history: History = { "nvidia/x": [{ at: "", result: "fail" }, { at: "", result: "fail" }] };
	const ranked = rank([{ model: "nvidia/x", probed: false }], { history, aa: {}, seeds: {}, evals: {}, now: new Date() });
	assert.equal(ranked.length, 0, "a missing key does not revive a dead model");
});

test("rate-limit records cannot push out the pass that forgives one failure (review finding 12)", () => {
	let h = appendHistory(undefined, { at: "0", result: "ok" });
	for (let i = 0; i < 13; i++) h = appendHistory(h, { at: String(i + 1), result: "limited" });
	h = appendHistory(h, { at: "14", result: "fail" });
	assert.equal(status(h), "ok");
	assert.ok(h.filter((r) => r.result === "limited").length <= 4);
});

test("AA slugs and names match provider ids despite vendor prefixes and parentheses", () => {
	const same: string[][] = [
		["nvidia-nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra 550B A55B (Reasoning)", "nvidia/nvidia/nemotron-3-ultra-550b-a55b", "ollama-cloud/nemotron-3-ultra"],
		["nvidia-nemotron-3-super-120b-a12b", "kilo/nvidia/nemotron-3-super-120b-a12b:free"],
		["GLM-4.7-Flash (Reasoning)", "zai-free/glm-4.7-flash"],
	];
	for (const group of same) assert.equal(new Set(group.map(family)).size, 1, group.join(", "));
	assert.equal(family("qwen3-5-397b-a17b"), "qwen-3-5", "a model name that starts like a vendor is kept");
});

test("only mode tags in parentheses are dropped, so sizes stay apart (review finding)", () => {
	assert.notEqual(family("Foo (7B)"), family("Foo (70B)"));
	assert.equal(family("Muse Glimmer (High)"), family("muse-glimmer"));
});
