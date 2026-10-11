/**
 * Routing decisions: how long a failed model cools down, which model takes the next request, and
 * the state file every pi process shares. Nothing here talks to pi, so it tests on plain Node.
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export interface PoolEntry {
	/** provider/model-id, as pi's model registry names it. */
	model: string;
	/** Requests per minute this model takes before we hold back on our side. */
	rpm?: number;
}

interface Cooldown {
	until: number;
	failures: number;
	reason: string;
	/** When it was set, so a request that started earlier cannot clear it by succeeding. */
	at: number;
}

export interface State {
	models: Record<string, Cooldown>;
	providers: Record<string, Cooldown>;
	/** Last rate-limit failure per shared-limit provider, to spot a limit across its models. */
	lastLimit: Record<string, { at: number; model: string }>;
	/** Dispatch times in the last minute, for models with an rpm cap. */
	dispatched: Record<string, number[]>;
	/**
	 * Models that answered but took long to start, until when. A preference, not a cooldown: a
	 * slow model still serves when nothing faster is ready.
	 */
	slow: Record<string, number>;
}

/** A first token later than this marks a model slow; free queues swing from 2 s to over 30 s. */
export const SLOW_START = 15 * SECOND;
/** How long a slow start keeps a model behind faster ones. */
export const SLOW_FOR = 10 * MINUTE;

export type Kind =
	| "auth"
	| "denied"
	| "minute"
	| "hourly"
	| "daily"
	| "quota"
	| "gone"
	| "slow"
	| "rate"
	| "client"
	| "other";

/** First match wins. base doubles with each consecutive failure, up to max. */
const KINDS: { kind: Kind; pattern: RegExp; base: number; max: number }[] = [
	{
		kind: "auth",
		pattern:
			/\b401\b|unauthori[sz]ed|invalid.{0,20}(api.?key|token|credential)|api.?key.{0,20}(not valid|invalid)|incorrect api key|missing api key|authentication/i,
		base: 6 * HOUR,
		max: 6 * HOUR,
	},
	{ kind: "denied", pattern: /\b403\b|forbidden|permission|not allowed|not available in your/i, base: HOUR, max: 6 * HOUR },
	{ kind: "minute", pattern: /per.?min|\brpm\b|\btpm\b/i, base: MINUTE, max: 30 * MINUTE },
	{ kind: "hourly", pattern: /per.?hour|hourly|req\/hr|\brph\b/i, base: 15 * MINUTE, max: HOUR },
	{ kind: "daily", pattern: /per.?day|daily|\brpd\b|\btpd\b|weekly|monthly|session limit/i, base: HOUR, max: 6 * HOUR },
	{ kind: "quota", pattern: /quota|exhausted|insufficient|billing|credit|usage limit|balance|payment required|\b402\b/i, base: HOUR, max: 6 * HOUR },
	{
		kind: "gone",
		pattern: /\b404\b|\b410\b|not.?found|does not exist|unavailable_model|no longer|deprecated|decommissioned/i,
		base: HOUR,
		max: 6 * HOUR,
	},
	// A model that leaves a request hanging tends to keep doing it (NVIDIA's free Kimi K3 queue, 2026-10-11).
	{ kind: "slow", pattern: /timed? ?out|timeout|ETIMEDOUT/i, base: 15 * MINUTE, max: 2 * HOUR },
	{
		kind: "rate",
		pattern: /\b429\b|rate.?limit|too many requests|concurrent|throttl|overloaded|capacity/i,
		base: 30 * SECOND,
		max: 30 * MINUTE,
	},
	{ kind: "client", pattern: /\b(400|413|422)\b|bad request|invalid request|unprocessable|thought.?signature/i, base: 5 * MINUTE, max: 5 * MINUTE },
	{ kind: "other", pattern: /[\s\S]*/, base: MINUTE, max: 30 * MINUTE },
];

const SHARED_KINDS = new Set<Kind>(["minute", "hourly", "daily", "quota", "rate"]);

export function emptyState(): State {
	return { models: {}, providers: {}, lastLimit: {}, dispatched: {}, slow: {} };
}

function record(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function cooldowns(raw: unknown): Record<string, Cooldown> {
	return Object.fromEntries(
		Object.entries(record(raw)).flatMap(([key, value]) => {
			const entry = value as Record<string, unknown>;
			if (
				typeof entry?.reason !== "string" ||
				!finite(entry.until) ||
				!finite(entry.failures) ||
				!finite(entry.at)
			) {
				return [];
			}
			return [[key, { until: entry.until, failures: entry.failures, reason: entry.reason, at: entry.at }]];
		}),
	);
}

function providerLimits(raw: unknown): State["lastLimit"] {
	return Object.fromEntries(
		Object.entries(record(raw)).flatMap(([key, value]) => {
			const entry = value as Record<string, unknown>;
			if (!finite(entry?.at) || typeof entry.model !== "string") return [];
			return [[key, { at: entry.at, model: entry.model }]];
		}),
	);
}

function dispatchHistory(raw: unknown): State["dispatched"] {
	return Object.fromEntries(
		Object.entries(record(raw)).flatMap(([key, value]) => {
			if (!Array.isArray(value)) return [];
			const times = value.filter(finite);
			return times.length ? [[key, times]] : [];
		}),
	);
}

function slowMarkers(raw: unknown): State["slow"] {
	return Object.fromEntries(
		Object.entries(record(raw)).flatMap(([key, value]) => (finite(value) ? [[key, value]] : [])),
	);
}

const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function isGemini3(modelId: string): boolean {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	return match !== null && Number(match[1]) >= 3;
}

export { isGemini3 };

function validSignature(value: unknown): boolean {
	return typeof value === "string" && value.length > 0 && value.length % 4 === 0 && SIGNATURE_PATTERN.test(value);
}

export type SignatureConstraint =
	| { mode: "unrestricted" }
	| { mode: "blocked" }
	| { mode: "pinned"; model: string };

/**
 * Gemini 3 models require every replayed functionCall to carry the thought signature the
 * model that made it received, and pi only replays a signature to that exact provider+model.
 * If the conversation has signed tool calls from one Gemini 3 model, only that model can
 * serve it; if from multiple (or any without a valid signature), no Gemini 3 model can.
 */
export function signatureConstraint(messages: readonly unknown[]): SignatureConstraint {
	let only: string | undefined;
	let broken = false;
	let sawToolCall = false;
	for (const message of messages) {
		const m = message as { role?: string; provider?: string; model?: string; content?: readonly unknown[] };
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		const from = m.provider && m.model ? `${m.provider}/${m.model}` : undefined;
		for (const block of m.content) {
			const b = block as { type?: string; thoughtSignature?: unknown };
			if (b?.type !== "toolCall") continue;
			sawToolCall = true;
			// Any tool call from a Gemini 3 model (any provider) constrains the conversation.
			const isGemini3Call = from && isGemini3(from.split("/")[1] ?? "");
			if (!from || !isGemini3Call) {
				// Non-Gemini tool call has no signature → breaks every Gemini 3 target.
				broken = true;
				continue;
			}
			if (!validSignature(b.thoughtSignature)) {
				// Invalid signature → even the original model can't replay it.
				broken = true;
				continue;
			}
			if (only === undefined) only = from;
			else if (only !== from) broken = true;
		}
	}
	if (!sawToolCall) return { mode: "unrestricted" };
	if (broken || only === undefined) return { mode: "blocked" };
	return { mode: "pinned", model: only };
}

export function splitKey(key: string): { provider: string; id: string } {
	const slash = key.indexOf("/");
	return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

export function keyOf(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The cooldown state in one directory, shared by every pi process through a lock file. */
export class Store {
	readonly dir: string;
	readonly file: string;
	private readonly lock: string;

	constructor(dir: string) {
		this.dir = dir;
		this.file = join(dir, "state.json");
		this.lock = `${this.file}.lock`;
	}

	/** Cooldowns are a cache of what failed: a missing or corrupt file costs a few failed requests, not the router. */
	load(): State {
		let raw: Record<string, any>;
		try {
			raw = record(JSON.parse(readFileSync(this.file, "utf8")));
		} catch {
			return emptyState();
		}
		return {
			models: cooldowns(raw.models),
			providers: cooldowns(raw.providers),
			lastLimit: providerLimits(raw.lastLimit),
			dispatched: dispatchHistory(raw.dispatched),
			slow: slowMarkers(raw.slow),
		};
	}

	private save(state: State): void {
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
		renameSync(tmp, this.file);
	}

	/**
	 * Load, change and save the state as one step across processes. The lock holds its owner's
	 * token; a waiter takes it over only once it is 5 s old, which means its holder died, since
	 * every holder releases it within milliseconds.
	 */
	update<T>(change: (state: State) => T): T {
		mkdirSync(this.dir, { recursive: true });
		const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
		for (;;) {
			try {
				writeFileSync(this.lock, token, { flag: "wx" });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					if (Date.now() - statSync(this.lock).mtimeMs > 5 * SECOND) unlinkSync(this.lock);
				} catch {}
				sleepSync(5);
			}
		}
		try {
			const state = this.load();
			const result = change(state);
			this.save(state);
			return result;
		} finally {
			try {
				if (readFileSync(this.lock, "utf8") === token) unlinkSync(this.lock);
			} catch {}
		}
	}
}

const UNITS = "milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h";

function toMs(value: string, unit: string | undefined): number {
	const u = (unit ?? "s").toLowerCase();
	const scale = u === "ms" || u.startsWith("milli") ? 1 : u.startsWith("h") ? HOUR : u.startsWith("m") ? MINUTE : SECOND;
	return Number(value) * scale;
}

/** Server-requested delay in ms, from the wordings providers use in error bodies. A bare number is seconds. */
export function parseRetryAfter(text: string): number | undefined {
	const stated =
		text.match(new RegExp(`retry[-_ ]?after["':\\s]*(\\d+(?:\\.\\d+)?)\\s*(${UNITS})?\\b`, "i")) ??
		text.match(new RegExp(`retry in\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNITS})?\\b`, "i")) ??
		text.match(/retryDelay["':\s]*"?(\d+(?:\.\d+)?)(s)\b/i);
	if (stated) return toMs(stated[1], stated[2]);
	const compact = text.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:(\d+(?:\.\d+)?)s)?/i);
	if (compact && (compact[1] || compact[2] || compact[3])) {
		return (Number(compact[1] ?? 0) * 3600 + Number(compact[2] ?? 0) * 60 + Number(compact[3] ?? 0)) * SECOND;
	}
	const worded = text.match(new RegExp(`try again in\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNITS})\\b`, "i"));
	return worded ? toMs(worded[1], worded[2]) : undefined;
}

/**
 * The kind of a failure. A 504 status from NVIDIA is a hang reported early: with vazhi's short
 * poll window NVIDIA answers 504 in about 7 s for a model it cannot serve, and a 1-minute cooldown
 * had a dead GLM 5.3 retried every few minutes. Only the leading status counts, and only from
 * NVIDIA; another provider's 504 may be a passing gateway blip.
 */
export function classify(text: string, provider?: string): (typeof KINDS)[number] {
	if (provider === "nvidia" && /^\s*504\b/.test(text)) return KINDS.find((k) => k.kind === "slow")!;
	return KINDS.find((k) => k.pattern.test(text))!;
}

function extend(entries: Record<string, Cooldown>, key: string, now: number, until: number, failures: number, reason: string): void {
	const existing = entries[key];
	// Never shorten a cooldown another failure or process already set.
	entries[key] = num(existing?.until) > until ? { ...existing, failures, at: now } : { until, failures, reason, at: now };
}

/** Cool a model down after a failure; returns the cooldown in ms. */
export function penalize(state: State, key: string, text: string, now: number, sharedLimits: string[] = []): number {
	const { provider } = splitKey(key);
	const rule = classify(text, provider);
	const failures = num(state.models[key]?.failures) + 1;
	// A delay the provider states beats our guess: Gemini says "exhausted" for per-minute limits too.
	const stated = parseRetryAfter(text);
	const ms = stated !== undefined ? Math.max(stated, 5 * SECOND) : Math.min(rule.base * 2 ** (failures - 1), rule.max);
	const reason = `${rule.kind}: ${text.replace(/\s+/g, " ").slice(0, 160)}`;
	extend(state.models, key, now, now + ms, failures, reason);

	// A bad key fails every model of its provider.
	if (rule.kind === "auth") extend(state.providers, provider, now, now + ms, 1, reason);

	// On a provider with a shared limit, two of its models limited within two minutes means the
	// account or IP is spent. Other providers limit per model, so they never cool as a whole.
	if (sharedLimits.includes(provider) && SHARED_KINDS.has(rule.kind)) {
		const last = state.lastLimit[provider];
		if (last && last.model !== key && now - num(last.at) < 2 * MINUTE) {
			extend(state.providers, provider, now, now + ms, 1, `provider-wide ${reason}`);
		}
		state.lastLimit[provider] = { at: now, model: key };
	}
	return ms;
}

/**
 * A model answered a request that started at startedAt: whatever cooled it or its provider before
 * then is over. A cooldown set after the request started stays, since it is newer evidence.
 */
export function recover(state: State, key: string, startedAt: number): void {
	const { provider } = splitKey(key);
	if (num(state.models[key]?.at) <= startedAt) delete state.models[key];
	if (num(state.providers[provider]?.at) <= startedAt) delete state.providers[provider];
	if (num(state.lastLimit[provider]?.at) <= startedAt) delete state.lastLimit[provider];
}

export function readyAt(state: State, entry: PoolEntry, now: number): number {
	const { provider } = splitKey(entry.model);
	let at = Math.max(num(state.models[entry.model]?.until), num(state.providers[provider]?.until));
	if (entry.rpm) {
		const recent = (state.dispatched[entry.model] ?? []).filter((t) => num(t) > now - MINUTE);
		if (recent.length >= entry.rpm) at = Math.max(at, recent[recent.length - entry.rpm] + MINUTE);
	}
	return at;
}

/**
 * Record how long a model took to its first token. A start slower than SLOW_START marks it for
 * SLOW_FOR; a fast start does not clear the mark early, or a slow model could clear itself the
 * moment it is the only one ready and flap back to the front. Expired marks are pruned here.
 */
export function noteStart(state: State, key: string, firstTokenMs: number, now: number): void {
	for (const [k, until] of Object.entries(state.slow)) if (num(until) <= now) delete state.slow[k];
	if (firstTokenMs > SLOW_START) state.slow[key] = Math.max(num(state.slow[key]), now + SLOW_FOR);
}

export type Choice = { pick: PoolEntry } | { pick?: undefined; next: PoolEntry; waitMs: number };

/**
 * The model for one request, from entries that have credentials, in pool order. Models that
 * started slowly lately go behind the rest. Within a turn it stays on the model already working
 * on it, unless that model is slow and a faster one is ready; a retry avoids the model that just
 * failed, even if its cooldown was lost. With nothing ready it names the model that frees up first.
 */
export function choose(entries: PoolEntry[], state: State, now: number, previous?: string, failed?: string): Choice {
	const ready = entries.filter((e) => readyAt(state, e, now) <= now);
	const unfailed = failed && ready.some((e) => e.model !== failed) ? ready.filter((e) => e.model !== failed) : ready;
	const isSlow = (e: PoolEntry) => num(state.slow[e.model]) > now;
	const usable = [...unfailed.filter((e) => !isSlow(e)), ...unfailed.filter(isSlow)];
	const stay = usable.find((e) => e.model === previous);
	const pick = stay && (!isSlow(stay) || isSlow(usable[0])) ? stay : usable[0];
	if (pick) return { pick };
	const next = entries.reduce((a, b) => (readyAt(state, b, now) < readyAt(state, a, now) ? b : a));
	return { next, waitMs: readyAt(state, next, now) - now };
}

/** Count a dispatch against the model's rpm cap. */
export function reserve(state: State, entry: PoolEntry, now: number): void {
	if (!entry.rpm) return;
	const recent = (state.dispatched[entry.model] ?? []).filter((t) => num(t) > now - MINUTE);
	state.dispatched[entry.model] = [...recent, now];
}

/**
 * Pick a model, waiting for one to free up, but never longer than maxWait in total: other
 * processes can keep taking the model that was about to free up. Returns the last choice, which
 * has no pick when the deadline would pass first.
 */
export async function pickWithin(
	attempt: () => Choice,
	maxWait: number,
	sleep: (ms: number) => Promise<void>,
	clock: () => number = Date.now,
): Promise<Choice> {
	const deadline = clock() + maxWait;
	for (;;) {
		const choice = attempt();
		if (choice.pick || choice.waitMs > deadline - clock()) return choice;
		await sleep(choice.waitMs + 50);
	}
}

/**
 * Client errors (400, 413, 422) reroute at most `limit` times in two minutes in one process, then
 * stay with pi: a request that fails everywhere should stop, not cool every model in turn.
 * Returns the updated list of reroute times, or undefined when the limit is reached.
 */
export function clientReroute(times: number[], now: number, limit = 3): number[] | undefined {
	const recent = times.filter((t) => t > now - 2 * MINUTE);
	return recent.length >= limit ? undefined : [...recent, now];
}

/** Why a model is not ready, for /vazhi. */
export function coolingReason(state: State, entry: PoolEntry, now: number): string | undefined {
	const { provider } = splitKey(entry.model);
	if (num(state.providers[provider]?.until) > now) return state.providers[provider].reason;
	if (num(state.models[entry.model]?.until) > now) return state.models[entry.model].reason;
	return readyAt(state, entry, now) > now ? `rpm ${entry.rpm}` : undefined;
}

export function formatDuration(ms: number): string {
	if (ms < MINUTE) return `${Math.ceil(ms / SECOND)}s`;
	if (ms < HOUR) return `${Math.ceil(ms / MINUTE)}m`;
	return `${(ms / HOUR).toFixed(1)}h`;
}
