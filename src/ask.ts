/**
 * One question to the pool without pi, for `vazhi ask` and for programs that import vazhi/core.
 * It routes with the same rules and the same state file as the pi extension, so a model cooling
 * in pi is skipped here and a failure here cools it for pi.
 *
 * With `fast`, it asks the fast list instead of the pool, and when the first model has not
 * answered within HEDGE_AFTER it asks the next one too and takes whichever answers first. A model
 * that loses that race is not penalized.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, bundledPool, loadPool, stateDir, type FastEntry } from "./pool.ts";
import { endpointOf, KEY_ENV, NVCF_POLL_SECONDS, OWN_PROVIDERS } from "./providers.ts";
import { choose, penalize, recover, reserve, SECOND, splitKey, Store } from "./router.ts";

export interface AskOptions {
	prompt: string;
	system?: string;
	/** Ask the fast list, hedging slow starts. Default false: the pool, one model at a time. */
	fast?: boolean;
	maxTokens?: number;
	temperature?: number;
	/** Total time for the question, retries included. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** For tests: the network, the environment (PI_CODING_AGENT_DIR, keys) and the clock. */
	fetch?: typeof fetch;
	env?: NodeJS.ProcessEnv;
}

export interface Answer {
	text: string;
	/** provider/model-id that answered. */
	model: string;
	ms: number;
}

export class AskError extends Error {
	override name = "AskError";
}

/** Start a second model when the first has not answered in this long (fast mode only). */
export const HEDGE_AFTER = 1.5 * SECOND;
const LIMITS = {
	fast: { total: 20 * SECOND, attempt: 8 * SECOND, maxTokens: 1024, parallel: 2 },
	pool: { total: 120 * SECOND, attempt: 90 * SECOND, maxTokens: 4096, parallel: 1 },
};

/** The key for a provider: pi's auth.json first, as pi does, then the environment. */
export function keyLookup(env: NodeJS.ProcessEnv = process.env): (provider: string) => string | undefined {
	let auth: Record<string, { type?: unknown; key?: unknown }> = {};
	try {
		auth = JSON.parse(readFileSync(join(agentDir(env), "auth.json"), "utf8"));
	} catch {}
	return (provider) => {
		const stored = auth[provider];
		if (stored?.type === "api_key" && typeof stored.key === "string" && stored.key && !stored.key.startsWith("!")) return stored.key;
		const name = KEY_ENV[provider];
		return (name && env[name]) || undefined;
	};
}

/** Whether vazhi can call this model on its own: it knows the endpoint, and has a key or needs none. */
export function callable(model: string, key: (provider: string) => string | undefined): boolean {
	const { provider } = splitKey(model);
	if (!endpointOf(provider)) return false;
	return !!OWN_PROVIDERS[provider]?.anonymous || !!key(provider);
}

/** Text of a chat completion, without a <think> block some models put in the answer. */
export function answerText(body: any): string {
	const content = body?.choices?.[0]?.message?.content;
	const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("") : "";
	return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

class Empty extends Error {}

async function complete(
	entry: FastEntry,
	key: string | undefined,
	options: AskOptions,
	maxTokens: number,
	signal: AbortSignal,
	doFetch: typeof fetch,
): Promise<string> {
	const { provider, id } = splitKey(entry.model);
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (key) headers.authorization = `Bearer ${key}`;
	if (provider === "nvidia") headers["nvcf-poll-seconds"] = NVCF_POLL_SECONDS;
	const messages = [...(options.system ? [{ role: "system", content: options.system }] : []), { role: "user", content: options.prompt }];
	const body: Record<string, unknown> = { model: id, messages, max_tokens: maxTokens };
	if (options.temperature !== undefined) body.temperature = options.temperature;
	if (entry.effort) body.reasoning_effort = entry.effort;
	const response = await doFetch(`${endpointOf(provider)}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
	const raw = await response.text();
	if (!response.ok) throw new Error(`${response.status} ${raw.replace(/\s+/g, " ").slice(0, 300)}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`not JSON: ${raw.slice(0, 120)}`);
	}
	const text = answerText(parsed);
	if (!text) throw new Empty("empty answer");
	return text;
}

type Outcome = { id: number; model: string; startedAt: number; text?: string; error?: unknown; aborted?: boolean };

function delay(ms: number): Promise<"timer"> {
	return new Promise((resolve) => setTimeout(resolve, ms, "timer").unref());
}

/** Ask one question; resolves with the first good answer or rejects with an AskError naming why. */
export async function ask(options: AskOptions): Promise<Answer> {
	const env = options.env ?? process.env;
	const doFetch = options.fetch ?? fetch;
	const limits = options.fast ? LIMITS.fast : LIMITS.pool;
	const maxTokens = options.maxTokens ?? limits.maxTokens;
	const dir = stateDir(env);
	const store = new Store(dir);
	const { pool } = loadPool(dir, bundledPool());
	const key = keyLookup(env);
	const list = options.fast ? pool.fast : pool.pool;
	const usable = list.filter((e) => callable(e.model, key));
	if (usable.length === 0) {
		throw new AskError(
			list.length === 0
				? `vazhi: the ${options.fast ? "fast list" : "pool"} is empty`
				: `vazhi: no ${options.fast ? "fast-list" : "pool"} model has a key; set one of ${[...new Set(Object.values(KEY_ENV))].join(", ")}`,
		);
	}

	const started = Date.now();
	const deadline = started + (options.timeoutMs ?? limits.total);
	const tried = new Set<string>();
	const failures: string[] = [];
	const running = new Map<number, { attempt: Promise<Outcome>; controller: AbortController }>();
	let nextId = 0;
	let waiting: { next: { model: string }; waitMs: number } | undefined;

	const stopAll = () => {
		for (const { controller } of running.values()) controller.abort();
	};
	options.signal?.addEventListener("abort", stopAll, { once: true });

	const launch = (): boolean => {
		const left = usable.filter((e) => !tried.has(e.model));
		if (left.length === 0) return false;
		const choice = store.update((state) => {
			const now = Date.now();
			const c = choose(left, state, now);
			if (c.pick) reserve(state, c.pick, now);
			return c;
		});
		if (!choice.pick) {
			waiting = { next: choice.next, waitMs: choice.waitMs };
			return false;
		}
		waiting = undefined;
		const entry = choice.pick as FastEntry;
		tried.add(entry.model);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`timed out after ${limits.attempt / SECOND}s`)), limits.attempt);
		timer.unref();
		const startedAt = Date.now();
		const id = nextId++;
		const attempt: Promise<Outcome> = complete(entry, key(splitKey(entry.model).provider), options, maxTokens, controller.signal, doFetch)
			.then((text) => ({ id, model: entry.model, startedAt, text }))
			.catch((error) => {
				// Aborted by us (a winner, the caller, the deadline): not the model's fault. A timeout is.
				const ours = controller.signal.aborted && !(controller.signal.reason instanceof Error && /timed out/.test(controller.signal.reason.message));
				return { id, model: entry.model, startedAt, error: controller.signal.reason ?? error, aborted: ours };
			})
			.finally(() => clearTimeout(timer));
		running.set(id, { attempt, controller });
		return true;
	};

	try {
		for (;;) {
			if (options.signal?.aborted) throw new AskError("vazhi: aborted");
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new AskError(`vazhi: no answer within ${Math.round((deadline - started) / SECOND)}s${failures.length ? `; ${failures.join("; ")}` : ""}`);
			if (running.size === 0 && !launch()) {
				if (waiting && waiting.waitMs < remaining) {
					await delay(waiting.waitMs + 50);
					continue;
				}
				const why = waiting ? `every model is cooling; ${waiting.next.model} is back in ${Math.ceil(waiting.waitMs / SECOND)}s` : "every model failed";
				throw new AskError(`vazhi: ${why}${failures.length ? `: ${failures.join("; ")}` : ""}`);
			}
			const hedge = options.fast && running.size < limits.parallel ? delay(HEDGE_AFTER) : undefined;
			const attempts = [...running.values()].map((r) => r.attempt);
			const winner = await Promise.race([...attempts, delay(remaining), ...(hedge ? [hedge] : [])]);
			if (winner === "timer") {
				// The hedge or the deadline: start another model if the deadline has not passed.
				if (deadline - Date.now() > 0) launch();
				continue;
			}
			running.delete(winner.id);
			if (winner.text !== undefined) {
				stopAll();
				store.update((state) => recover(state, winner.model, winner.startedAt));
				return { text: winner.text, model: winner.model, ms: Date.now() - started };
			}
			if (winner.aborted) continue;
			const message = winner.error instanceof Error ? winner.error.message : String(winner.error);
			failures.push(`${winner.model}: ${message.slice(0, 120)}`);
			if (!(winner.error instanceof Empty)) {
				store.update((state) => penalize(state, winner.model, message, Date.now(), pool.sharedLimits));
			}
			// Replace a failed model at once rather than at the next hedge.
			if (running.size > 0 && running.size < limits.parallel) launch();
		}
	} finally {
		stopAll();
		options.signal?.removeEventListener("abort", stopAll);
	}
}
