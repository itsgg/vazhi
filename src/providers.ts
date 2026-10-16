/**
 * Where requests may go. Base URLs live here and nowhere else: the nightly pool can name models
 * but never endpoints, so a bad pool file cannot send anyone's prompts or keys somewhere new.
 */

/** Sent as the key by providers that serve anonymous callers; the header hook strips it. */
export const ANONYMOUS_KEY = "vazhi-anonymous";

const COMPAT = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsStore: false,
	maxTokensField: "max_tokens",
} as const;

export interface OwnProvider {
	name: string;
	baseUrl: string;
	/** Set for providers that answer without a key; a key from /login still replaces it. */
	anonymous?: boolean;
	compat: Record<string, unknown>;
}

/** Providers vazhi registers itself. Their model lists come from the pool file. */
export const OWN_PROVIDERS: Record<string, OwnProvider> = {
	kilo: {
		// 200 requests an hour per IP without a key; Kilo is retiring the "Bearer anonymous"
		// placeholder (Kilo-Org/cloud#6480), so anonymous requests carry no Authorization header.
		name: "Kilo Gateway (free models)",
		baseUrl: "https://api.kilo.ai/api/gateway",
		anonymous: true,
		compat: COMPAT,
	},
	ovh: {
		// The anonymous tier, 2 requests a minute per IP per model, rejects any Authorization header.
		name: "OVHcloud AI Endpoints (anonymous)",
		baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
		anonymous: true,
		compat: COMPAT,
	},
	llm7: {
		name: "LLM7 (free tier)",
		baseUrl: "https://api.llm7.io/v1",
		anonymous: true,
		compat: COMPAT,
	},
	"ollama-cloud": {
		name: "Ollama Cloud (free starter models, key via /login)",
		baseUrl: "https://ollama.com/v1",
		compat: COMPAT,
	},
	"zai-free": {
		name: "Z.ai free models (key via /login)",
		baseUrl: "https://api.z.ai/api/paas/v4",
		compat: { ...COMPAT, thinkingFormat: "zai" },
	},
};

/** Ollama's free starter set, from a third-party probe of a $0 key on 2026-09-02. */
const OLLAMA_FREE = ["nemotron-3-ultra", "gpt-oss:120b", "gemma4:31b"];
/** Priced "Free" on Z.ai's international platform (docs.z.ai pricing, 2026-10-11). */
const ZAI_FREE = ["glm-4.7-flash", "glm-4.5-flash"];
/**
 * Inside Workers AI's free 10K neurons a day (pricing, 2026-10-16). Paid-only rows are left out:
 * Kimi K2.6, Kimi K2.7 Code, GLM 5.2, GLM 5.3, GLM 5.3 Flash, DeepSeek V4 Flash and V4 Pro.
 * Llama 3.3 70B's 24K window is below one pi turn.
 */
const CLOUDFLARE_FREE = [
	"@cf/zai-org/glm-4.7-flash",
	"@cf/openai/gpt-oss-120b",
	"@cf/openai/gpt-oss-20b",
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/qwen/qwen3.8-27b",
];

/**
 * Which models the downloaded pool may use, per provider. Each rule admits only models that are
 * free by the provider's own terms, so a compromised pool cannot route anyone to a paid model:
 * - kilo and openrouter: only ":free" models, since one key can buy paid ones too.
 * - ovh and llm7: anything, since vazhi sends no key and a paid model fails instead of billing.
 * - nvidia: anything; NIM's API catalog is a free trial with no billing.
 * - google: Flash and Flash-Lite, the models with a free tier. A key whose project has billing
 *   enabled is still billed; README tells users to use a free project.
 * - ollama-cloud, zai-free, cloudflare-workers-ai: fixed lists above.
 * A user's own config.json is not checked: what they put there is their choice.
 */
const FREE_RULES: Record<string, (id: string) => boolean> = {
	kilo: (id) => id.endsWith(":free") || id.endsWith("/free"),
	ovh: () => true,
	llm7: () => true,
	nvidia: () => true,
	google: (id) => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(id),
	openrouter: (id) => id.endsWith(":free") || id === "openrouter/free",
	"ollama-cloud": (id) => OLLAMA_FREE.includes(id),
	"zai-free": (id) => ZAI_FREE.includes(id),
	"cloudflare-workers-ai": (id) => CLOUDFLARE_FREE.includes(id),
};

export function allowedInRemotePool(provider: string, id: string): boolean {
	return Object.hasOwn(FREE_RULES, provider) && FREE_RULES[provider](id);
}

export function isOwnProvider(provider: string): boolean {
	return Object.hasOwn(OWN_PROVIDERS, provider);
}
