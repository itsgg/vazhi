import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedInRemotePool } from "../src/providers.ts";

test("the downloaded pool can only reach models free by each provider's terms (review finding 1)", () => {
	const allowed: [string, string][] = [
		["kilo", "nvidia/nemotron-3-ultra-550b-a55b:free"],
		["kilo", "kilo-auto/free"],
		["openrouter", "poolside/laguna-s-2.1:free"],
		["google", "gemini-3.8-flash"],
		["google", "gemini-3.5-flash-lite"],
		["nvidia", "z-ai/glm-5.3-flash"],
		["ovh", "Qwen3.8-27B"],
		["ollama-cloud", "nemotron-3-ultra"],
		["zai-free", "glm-4.7-flash"],
		["cloudflare-workers-ai", "@cf/zai-org/glm-4.7-flash"],
		["cloudflare-workers-ai", "@cf/openai/gpt-oss-120b"],
		["cloudflare-workers-ai", "@cf/openai/gpt-oss-20b"],
		["cloudflare-workers-ai", "@cf/google/gemma-4-26b-a4b-it"],
		["cloudflare-workers-ai", "@cf/qwen/qwen3.8-27b"],
	];
	const refused: [string, string][] = [
		["kilo", "anthropic/claude-opus-5"],
		["openrouter", "anthropic/claude-opus-5"],
		["google", "gemini-3.1-pro-preview"],
		["mistral", "mistral-medium-3.5"],
		["ollama-cloud", "kimi-k3"],
		["zai-free", "glm-5.3-flash"],
		["cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"],
		["cloudflare-workers-ai", "@cf/zai-org/glm-5.3"],
		["cloudflare-workers-ai", "@cf/deepseek-ai/deepseek-v4-flash-0731"],
		["cloudflare-workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
		["anthropic", "claude-opus-5"],
		["toString", "x"],
		["__proto__", "x"],
	];
	for (const [p, id] of allowed) assert.ok(allowedInRemotePool(p, id), `${p}/${id}`);
	for (const [p, id] of refused) assert.ok(!allowedInRemotePool(p, id), `${p}/${id}`);
});
