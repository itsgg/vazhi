/**
 * Nightly: rebuild pool.json from what the free providers list and what actually answers.
 *
 * 1. Candidates: free chat models with tool calling from each provider's public catalog. For
 *    pi's built-in providers only models in pi's own catalog qualify, since vazhi routes through
 *    pi's model registry: the catalog bundled with the pinned pi, plus the live one pi itself
 *    downloads from pi.dev every 4 hours, so a model pi learns about today counts tonight.
 * 2. Probe: one tool-calling request each, where a key or anonymous access allows it.
 * 3. Rank: scripts/rank.ts.
 *
 * Env, each optional: NVIDIA_API_KEY, GEMINI_API_KEY, AA_API_KEY. Reads and writes
 * data/history.json (kept between runs by the CI cache, not committed) and writes pool.json only
 * when its content changes. Usage: node scripts/discover.ts [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { NVIDIA_MODELS } from "@earendil-works/pi-ai/providers/nvidia.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { parsePool, type ModelMeta, type PoolFile } from "../src/pool.ts";
import { allowedInRemotePool, OWN_PROVIDERS } from "../src/providers.ts";
import { classify } from "../src/router.ts";
import { appendHistory, family, rank, type Candidate, type EvalRecord, type History, type ProbeResult } from "./rank.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (path: string) => JSON.parse(readFileSync(ROOT + path, "utf8"));
const exclude = read("data/exclude.json") as { models: Record<string, string>; patterns: string[] };
const statics = read("data/static.json");
const seeds = (read("data/seed-scores.json") as { scores: Record<string, number> }).scores;
const HISTORY = "data/history.json";
const EVALS = "data/eval.json";
const DRY = process.argv.includes("--dry-run");
const log = (...args: unknown[]) => console.error(...args);

const excluded = (model: string) =>
	model in exclude.models || exclude.patterns.some((p) => model.toLowerCase().includes(p.toLowerCase()));

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return response.json();
}

export interface Found {
	candidates: Candidate[];
	models: Record<string, ModelMeta[]>;
}

/** A catalog that answers with nothing is broken, not empty: keep the provider's previous rows. */
function rows(name: string, data: unknown): any[] {
	if (!Array.isArray(data) || data.length === 0) throw new Error(`${name}: empty or malformed catalog`);
	return data;
}

/** Kilo's free pool: :free models that take tools (the only ones vazhi may route to there). */
export async function kilo(found: Found): Promise<void> {
	const data = rows("kilo", (await getJson("https://api.kilo.ai/api/gateway/models")).data);
	for (const m of data) {
		const free = allowedInRemotePool("kilo", String(m.id));
		const tools = (m.supported_parameters ?? []).includes("tools");
		const context = Number(m.context_length) || 0;
		if (!free || !tools || context < 32_000 || excluded(`kilo/${m.id}`)) continue;
		const maxOut = Number(m.top_provider?.max_completion_tokens) || 32_768;
		found.models.kilo.push({
			id: m.id,
			name: `${String(m.name ?? m.id).slice(0, 100)} (Kilo)`,
			reasoning: (m.supported_parameters ?? []).includes("reasoning"),
			input: (m.architecture?.input_modalities ?? []).includes("image") ? ["text", "image"] : ["text"],
			contextWindow: context,
			maxTokens: Math.min(maxOut, context, 65_536),
		});
		found.candidates.push({ model: `kilo/${m.id}`, probed: true });
	}
}

/** OVH's anonymous catalog: ids only, metadata from data/static.json. */
async function ovh(found: Found): Promise<void> {
	const data = rows("ovh", (await getJson(`${OWN_PROVIDERS.ovh.baseUrl}/models`)).data);
	for (const m of data) {
		const id = String(m.id);
		if (excluded(`ovh/${id}`) || /llama-3_3|mistral-7b|nemo/i.test(id)) continue;
		const known = statics.ovh[id] ?? statics.ovh.default;
		found.models.ovh.push({ id, name: `${id} (OVH)`, ...known });
		found.candidates.push({ model: `ovh/${id}`, probed: true });
	}
}

/** LLM7: the "turbo" chat models that free callers reach and that take tools. */
async function llm7(found: Found): Promise<void> {
	const data = rows("llm7", (await getJson(`${OWN_PROVIDERS.llm7.baseUrl}/models`)).data);
	for (const m of data) {
		if (m.tier !== "turbo" || m.model_type !== "chat" || !m.tools_calling || excluded(`llm7/${m.id}`)) continue;
		const context = Number(m.context_window?.tokens) || 128_000;
		found.models.llm7.push({
			id: m.id,
			name: `${m.id} (LLM7)`,
			reasoning: !!m.reasoning,
			input: m.capabilities?.vision ? ["text", "image"] : ["text"],
			contextWindow: context,
			maxTokens: Math.min(32_768, context),
		});
		found.candidates.push({ model: `llm7/${m.id}`, probed: true });
	}
}

/** Ollama Cloud and Z.ai: keyed providers CI holds no key for; their rows come from data/static.json. */
function staticRows(found: Found): void {
	for (const provider of ["ollama-cloud", "zai-free"]) {
		for (const m of statics.models[provider] ?? []) {
			found.models[provider].push(m);
			found.candidates.push({ model: `${provider}/${m.id}`, probed: false });
		}
	}
	for (const model of statics.builtin ?? []) found.candidates.push({ model, probed: false });
}

/**
 * Chat model ids pi knows for a built-in provider: the catalog bundled with the pinned pi, plus
 * the live catalog pi downloads from pi.dev. When pi.dev fails or answers with nothing, the
 * provider's models in last night's pool stand in for the live part, so an outage drops nothing.
 */
export async function piCatalog(provider: string, bundled: Record<string, unknown>, previous: string[] = []): Promise<string[]> {
	const ids = new Set(Object.keys(bundled));
	try {
		const live = await getJson(`https://pi.dev/api/models/providers/${encodeURIComponent(provider)}?types=chat`);
		const list = Array.isArray(live) ? live : Array.isArray(live?.models) ? live.models : [];
		const chat = list.filter((m: any) => typeof m?.id === "string" && (m.type ?? "chat") === "chat");
		if (chat.length === 0) throw new Error("empty or malformed catalog");
		for (const m of chat) ids.add(m.id);
	} catch (error) {
		log(`pi.dev catalog for ${provider} failed, keeping last night's models: ${(error as Error).message}`);
		for (const id of previous) ids.add(id);
	}
	return [...ids];
}

/** The ids a provider had in the committed pool, the fallback when a live catalog fails. */
function previousIds(provider: string): string[] {
	try {
		return parsePool(read("pool.json"))
			.pool.filter((e) => e.model.startsWith(`${provider}/`))
			.map((e) => e.model.slice(provider.length + 1));
	} catch {
		return [];
	}
}

/** NVIDIA NIM: pi's catalog, limited to what NIM lists today. */
async function nvidia(found: Found): Promise<void> {
	const listed = new Set(rows("nvidia", (await getJson("https://integrate.api.nvidia.com/v1/models")).data).map((m: any) => m.id));
	for (const id of await piCatalog("nvidia", NVIDIA_MODELS, previousIds("nvidia"))) {
		if (!listed.has(id) || excluded(`nvidia/${id}`)) continue;
		found.candidates.push({ model: `nvidia/${id}`, probed: !!process.env.NVIDIA_API_KEY });
	}
}

/** Gemini: the Flash and Flash-Lite models in pi's catalog; the probe finds out which are free. */
async function google(found: Found): Promise<void> {
	for (const id of await piCatalog("google", GOOGLE_MODELS, previousIds("google"))) {
		if (!/^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(id) || excluded(`google/${id}`)) continue;
		found.candidates.push({ model: `google/${id}`, probed: !!process.env.GEMINI_API_KEY });
	}
}

/** OpenRouter: :free models in pi's catalog that OpenRouter still lists with tool support. */
async function openrouter(found: Found): Promise<void> {
	const data = rows("openrouter", (await getJson("https://openrouter.ai/api/v1/models")).data);
	const live = new Set(data.filter((m: any) => (m.supported_parameters ?? []).includes("tools")).map((m: any) => m.id));
	for (const id of await piCatalog("openrouter", OPENROUTER_MODELS, previousIds("openrouter"))) {
		if ((!id.endsWith(":free") && id !== "openrouter/free") || !live.has(id) || excluded(`openrouter/${id}`)) continue;
		found.candidates.push({ model: `openrouter/${id}`, probed: false });
	}
}

const TOOLS = [
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a file from disk",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	},
];

function endpoint(model: string): { url: string; headers: Record<string, string>; id: string } | undefined {
	const slash = model.indexOf("/");
	const provider = model.slice(0, slash);
	const id = model.slice(slash + 1);
	if (provider in OWN_PROVIDERS && OWN_PROVIDERS[provider].anonymous) return { url: OWN_PROVIDERS[provider].baseUrl, headers: {}, id };
	if (provider === "nvidia" && process.env.NVIDIA_API_KEY)
		return { url: "https://integrate.api.nvidia.com/v1", headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` }, id };
	if (provider === "google" && process.env.GEMINI_API_KEY)
		return {
			url: "https://generativelanguage.googleapis.com/v1beta/openai",
			headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}` },
			id,
		};
	return undefined;
}

/** Provider errors can carry account and project identifiers; CI logs are public. */
export function redact(text: string): string {
	return text
		.replace(/(account|org|organization|project|consumer|user|tenant)([_-]?id)?(['":=\s]+)[A-Za-z0-9_./-]{6,}/gi, "$1$2$3<redacted>")
		.replace(/projects\/\d+/g, "projects/<redacted>")
		.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer <redacted>");
}

/**
 * What a failed probe says about the model. Rate limits say nothing (CI shares IPs and quotas);
 * a keyless provider asking for a key or payment says the model is not free there; a keyed
 * provider's quota or key trouble is ours, not the model's.
 */
export function verdict(status: number, text: string, anonymous: boolean): ProbeResult {
	if (/limit: ?0\b/.test(text)) return "fail"; // Gemini: no free tier for this model
	if (status === 429 || /rate.?limit|too many requests|throttl/i.test(text)) return "limited";
	const kind = classify(`${status} ${text}`).kind;
	if (anonymous && (status === 401 || status === 402 || status === 403 || kind === "auth")) return "fail";
	return ["auth", "quota", "daily", "minute", "hourly"].includes(kind) ? "limited" : "fail";
}

/** One tool-calling request. Rate limits mean "limited", not failure: CI shares IPs with others. */
export async function probe(model: string): Promise<{ result: ProbeResult; ms?: number; error?: string }> {
	const target = endpoint(model);
	if (!target) return { result: "skipped" };
	const started = Date.now();
	try {
		const response = await fetch(`${target.url}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...target.headers },
			body: JSON.stringify({
				model: target.id,
				messages: [
					{ role: "system", content: "You are a coding agent. Use tools." },
					{ role: "user", content: "Read the file /etc/hostname using the tool." },
				],
				tools: TOOLS,
				max_tokens: 1024,
			}),
			signal: AbortSignal.timeout(45_000),
		});
		const ms = Date.now() - started;
		const text = await response.text();
		if (!response.ok) {
			const error = redact(`${response.status} ${text.replace(/\s+/g, " ").slice(0, 200)}`);
			return { result: verdict(response.status, text, !target.headers.Authorization), ms, error };
		}
		const call = JSON.parse(text).choices?.[0]?.message?.tool_calls?.[0];
		const args = call ? JSON.parse(call.function?.arguments || "{}") : undefined;
		if (call?.function?.name === "read_file" && typeof args?.path === "string") return { result: "ok", ms };
		return { result: "fail", ms, error: "answered without a valid tool call" };
	} catch (error) {
		return { result: "fail", ms: Date.now() - started, error: redact(String((error as Error).message ?? error).slice(0, 200)) };
	}
}

/** Probe everything, a few at a time per provider; OVH and LLM7 one at a time to respect their limits. */
async function probeAll(candidates: Candidate[]): Promise<Record<string, Awaited<ReturnType<typeof probe>>>> {
	const lanes: Record<string, number> = { nvidia: 4, kilo: 2, google: 1, ovh: 1, llm7: 1 };
	const byProvider = new Map<string, string[]>();
	for (const c of candidates.filter((c) => c.probed)) {
		const provider = c.model.slice(0, c.model.indexOf("/"));
		byProvider.set(provider, [...(byProvider.get(provider) ?? []), c.model]);
	}
	const results: Record<string, Awaited<ReturnType<typeof probe>>> = {};
	await Promise.all(
		[...byProvider].map(async ([provider, models]) => {
			const queue = [...models];
			const width = lanes[provider] ?? 1;
			await Promise.all(
				Array.from({ length: width }, async () => {
					for (let model = queue.shift(); model; model = queue.shift()) {
						results[model] = await probe(model);
						log(`probe ${model}: ${results[model].result} ${results[model].ms ?? ""}ms ${results[model].error ?? ""}`);
						if (provider === "ovh" || provider === "llm7") await new Promise((r) => setTimeout(r, 3_000));
					}
				}),
			);
		}),
	);
	return results;
}

/** AA coding index per model family; the best variant wins (a model's reasoning setting, say). */
async function artificialAnalysis(): Promise<Record<string, number>> {
	if (!process.env.AA_API_KEY) return {};
	const data = (await getJson("https://artificialanalysis.ai/api/v2/data/llms/models", { "x-api-key": process.env.AA_API_KEY })).data ?? [];
	const scores: Record<string, number> = {};
	for (const m of data) {
		const score = m.evaluations?.artificial_analysis_coding_index;
		if (typeof score !== "number") continue;
		for (const key of new Set([family(m.slug ?? ""), family(m.name ?? "")])) {
			if (key) scores[key] = Math.max(scores[key] ?? 0, score);
		}
	}
	return scores;
}

function stable(pool: PoolFile): string {
	return JSON.stringify({ ...pool, generated: "" });
}

async function main() {
	const found: Found = { candidates: [], models: Object.fromEntries(Object.keys(OWN_PROVIDERS).map((p) => [p, []])) };
	for (const [name, step] of Object.entries({ kilo, ovh, llm7, nvidia, openrouter })) {
		try {
			await step(found);
		} catch (error) {
			log(`catalog ${name} failed, keeping its previous rows: ${(error as Error).message}`);
			const previous = parsePool(read("pool.json"));
			for (const e of previous.pool.filter((e) => e.model.startsWith(`${name}/`))) found.candidates.push({ model: e.model, probed: !!endpoint(e.model) });
			if (name in found.models) found.models[name] = previous.models[name] ?? [];
		}
	}
	await google(found);
	staticRows(found);

	const history: History = existsSync(ROOT + HISTORY) ? read(HISTORY) : {};
	const results = await probeAll(found.candidates);
	const at = new Date().toISOString();
	for (const [model, r] of Object.entries(results)) {
		if (r.result === "skipped") continue;
		history[model] = appendHistory(history[model], { at, result: r.result, ms: r.ms, error: r.error });
	}

	let aa: Record<string, number> = {};
	try {
		aa = await artificialAnalysis();
	} catch (error) {
		log(`Artificial Analysis failed, using seed scores: ${(error as Error).message}`);
	}
	const evals: Record<string, EvalRecord> = existsSync(ROOT + EVALS) ? read(EVALS).models ?? {} : {};
	const ranked = rank(found.candidates, { history, aa, seeds, evals, now: new Date() });

	const inPool = new Set(ranked.map((r) => r.model));
	// Sorted, so a catalog that merely reorders its models does not change pool.json.
	const models = Object.fromEntries(
		Object.entries(found.models).map(([p, list]) => [
			p,
			list.filter((m) => inPool.has(`${p}/${m.id}`)).sort((a, b) => a.id.localeCompare(b.id)),
		]),
	);
	const next = parsePool({
		version: 1,
		generated: at,
		sharedLimits: ["kilo", "llm7"],
		models,
		pool: ranked,
	});
	const previous = existsSync(ROOT + "pool.json") ? parsePool(read("pool.json")) : undefined;
	const changed = !previous || stable(previous) !== stable(next);
	log(`${found.candidates.length} candidates, ${ranked.length} in pool, ${Object.keys(aa).length} AA families; pool ${changed ? "changed" : "unchanged"}`);
	if (DRY) {
		console.log(JSON.stringify(next, null, 2));
		return;
	}
	writeFileSync(ROOT + HISTORY, `${JSON.stringify(history, null, 1)}\n`);
	const attribution = Object.keys(aa).length ? "Coding scores from Artificial Analysis, https://artificialanalysis.ai/" : undefined;
	if (changed) writeFileSync(ROOT + "pool.json", `${JSON.stringify({ ...next, attribution }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
