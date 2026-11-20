/**
 * The pool: which models free/auto may use, best first, and the model lists of vazhi's own
 * providers. Three layers, later ones winning:
 *
 * 1. pool.json shipped in the package.
 * 2. The nightly pool.json from GitHub, cached in <agent dir>/vazhi/pool-cache.json, checked at
 *    the start of each session and each turn, and downloaded when the copy is 12 hours old (an
 *    hour after a failed try). It may only name models free by each provider's rule (providers.ts).
 * 3. <agent dir>/vazhi/config.json, the user's: replace the pool, exclude or prefer models, or
 *    turn the download off. Nothing in it is restricted; it is the user's own choice.
 *
 * Besides the pool, a short `fast` list serves one-shot questions where time to the answer
 * matters more than coding skill (`vazhi ask --fast`). It comes from data/fast.json through the
 * same nightly file, under the same free rules.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedInRemotePool, OWN_PROVIDERS } from "./providers.ts";
import { HOUR, type PoolEntry } from "./router.ts";

export const REMOTE_URL = "https://raw.githubusercontent.com/itsgg/vazhi/main/pool.json";
const REFRESH_EVERY = 12 * HOUR;
/** After a failed download: one network blip should not hold back tonight's pool for 12 hours. */
const RETRY_AFTER = HOUR;

export interface ModelMeta {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

export interface RankedEntry extends PoolEntry {
	score?: number;
	status?: string;
}

/** How hard a fast-list model may think before it answers, sent as reasoning_effort. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface FastEntry extends PoolEntry {
	effort?: Effort;
}

export interface PoolFile {
	version: 1;
	generated: string;
	/** Providers whose limits are per account or IP, not per model. */
	sharedLimits: string[];
	/** Model lists for vazhi's own providers. */
	models: Record<string, ModelMeta[]>;
	pool: RankedEntry[];
	/** Quick models for one-shot questions, fastest first; empty when the file has none. */
	fast: FastEntry[];
}

export interface UserConfig {
	pool?: RankedEntry[];
	/** Models (provider/id) or whole providers to leave out. */
	exclude?: string[];
	/** Models to move to the front, in this order. */
	prefer?: string[];
	/** Fetch the nightly pool from GitHub. Default true. */
	autoUpdate?: boolean;
	/** Replace the fast list. */
	fast?: FastEntry[];
}

/** pi's agent directory, resolved as pi resolves it, so the CLI and pi share one state. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) return dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
	return join(homedir(), ".pi", "agent");
}

/** Where vazhi keeps its state, cache and config. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "vazhi");
}

const ID = /^[A-Za-z0-9._:@/+-]{1,200}$/;

function isModelKey(value: unknown): value is string {
	return typeof value === "string" && ID.test(value) && value.indexOf("/") > 0;
}

function entry(raw: any): RankedEntry | undefined {
	if (!isModelKey(raw?.model)) return undefined;
	const out: RankedEntry = { model: raw.model };
	if (Number.isInteger(raw.rpm) && raw.rpm > 0 && raw.rpm < 10_000) out.rpm = raw.rpm;
	if (typeof raw.score === "number" && Number.isFinite(raw.score)) out.score = raw.score;
	if (typeof raw.status === "string" && raw.status.length < 40) out.status = raw.status;
	return out;
}

function fastEntry(raw: any): FastEntry | undefined {
	const base = entry(raw);
	if (!base) return undefined;
	const out: FastEntry = { model: base.model };
	if (base.rpm) out.rpm = base.rpm;
	if (EFFORTS.includes(raw.effort)) out.effort = raw.effort;
	return out;
}

function remoteAllowed(e: PoolEntry): boolean {
	const slash = e.model.indexOf("/");
	return allowedInRemotePool(e.model.slice(0, slash), e.model.slice(slash + 1));
}

function meta(raw: any): ModelMeta | undefined {
	const ok =
		typeof raw?.id === "string" &&
		ID.test(raw.id) &&
		typeof raw.name === "string" &&
		raw.name.length <= 120 &&
		typeof raw.reasoning === "boolean" &&
		Array.isArray(raw.input) &&
		raw.input.length > 0 &&
		raw.input.every((i: unknown) => i === "text" || i === "image") &&
		Number.isInteger(raw.contextWindow) &&
		raw.contextWindow >= 1_000 &&
		raw.contextWindow <= 20_000_000 &&
		Number.isInteger(raw.maxTokens) &&
		raw.maxTokens >= 256 &&
		raw.maxTokens <= raw.contextWindow;
	return ok
		? { id: raw.id, name: raw.name, reasoning: raw.reasoning, input: raw.input, contextWindow: raw.contextWindow, maxTokens: raw.maxTokens }
		: undefined;
}

/**
 * Validate a pool file. Invalid entries are dropped, not fatal, so one bad row cannot take the
 * router down. A pool from GitHub keeps only models of free providers and of vazhi's own.
 */
export function parsePool(raw: any): PoolFile {
	if (raw?.version !== 1 || !Array.isArray(raw.pool)) throw new Error("not a vazhi pool file (version 1)");
	const pool = raw.pool.map(entry).filter((e: RankedEntry | undefined): e is RankedEntry => !!e && remoteAllowed(e));
	const fast = (Array.isArray(raw.fast) ? raw.fast : [])
		.map(fastEntry)
		.filter((e: FastEntry | undefined): e is FastEntry => !!e && remoteAllowed(e));
	const models: Record<string, ModelMeta[]> = {};
	for (const provider of Object.keys(OWN_PROVIDERS)) {
		const list = Array.isArray(raw.models?.[provider]) ? raw.models[provider] : [];
		models[provider] = list
			.map(meta)
			.filter((m: ModelMeta | undefined): m is ModelMeta => !!m && allowedInRemotePool(provider, m.id));
	}
	const sharedLimits = Array.isArray(raw.sharedLimits) ? raw.sharedLimits.filter((p: unknown) => typeof p === "string") : [];
	return { version: 1, generated: typeof raw.generated === "string" ? raw.generated : "", sharedLimits, models, pool, fast };
}

/** The pool.json shipped in the package. */
export function bundledPool(): PoolFile {
	return parsePool(readJson(fileURLToPath(new URL("../pool.json", import.meta.url))));
}

function readJson(file: string): any {
	return JSON.parse(readFileSync(file, "utf8"));
}

function writeAtomic(file: string, data: unknown): void {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(tmp, file);
}

let lastConfig: UserConfig = {};

/** The user's config, or the last good read of it while an editor is halfway through saving. */
export function readConfig(dir: string): UserConfig {
	let raw: any;
	try {
		raw = readJson(join(dir, "config.json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return (lastConfig = {});
		return lastConfig;
	}
	const config: UserConfig = {};
	if (Array.isArray(raw?.pool)) config.pool = raw.pool.map(entry).filter((e: RankedEntry | undefined): e is RankedEntry => !!e);
	if (Array.isArray(raw?.exclude)) config.exclude = raw.exclude.filter((x: unknown) => typeof x === "string");
	if (Array.isArray(raw?.prefer)) config.prefer = raw.prefer.filter(isModelKey);
	if (typeof raw?.autoUpdate === "boolean") config.autoUpdate = raw.autoUpdate;
	if (Array.isArray(raw?.fast)) config.fast = raw.fast.map(fastEntry).filter((e: FastEntry | undefined): e is FastEntry => !!e);
	return (lastConfig = config);
}

interface Cache {
	/** When the last download succeeded. */
	fetchedAt: number;
	/** Not before this time, after a failed download. */
	retryAt: number;
	pool?: PoolFile;
}

function readCache(dir: string): Cache {
	try {
		const raw = readJson(join(dir, "pool-cache.json"));
		const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		return { fetchedAt: time(raw?.fetchedAt), retryAt: time(raw?.retryAt), pool: raw?.pool ? parsePool(raw.pool) : undefined };
	} catch {
		return { fetchedAt: 0, retryAt: 0 };
	}
}

export type PoolSource = "bundled" | "nightly" | "config";

/** The pool in effect: the newer of the bundled and nightly pools, then the user's config. */
export function loadPool(dir: string, bundled: PoolFile): { pool: PoolFile; source: PoolSource } {
	const cached = readCache(dir).pool;
	const base = cached && cached.generated > bundled.generated ? cached : bundled;
	const config = readConfig(dir);
	let entries = config.pool ?? base.pool;
	const excluded = (model: string) =>
		(config.exclude ?? []).some((x) => model === x || model.startsWith(x.endsWith("/") ? x : `${x}/`));
	entries = entries.filter((e) => !excluded(e.model));
	if (config.prefer?.length) {
		const front = config.prefer.map((m) => entries.find((e) => e.model === m) ?? { model: m });
		entries = [...front, ...entries.filter((e) => !config.prefer!.includes(e.model))];
	}
	// A nightly pool from before the fast list existed has none; the bundled one stands in.
	const fast = (config.fast ?? (base.fast.length ? base.fast : bundled.fast)).filter((e) => !excluded(e.model));
	const source: PoolSource = config.pool ? "config" : base === cached ? "nightly" : "bundled";
	return { pool: { ...base, pool: entries, fast }, source };
}

/** Whether a download is due: the copy is 12 hours old and no failed try asked to wait. */
export function refreshDue(dir: string, now = Date.now()): boolean {
	if (readConfig(dir).autoUpdate === false) return false;
	const cache = readCache(dir);
	return now >= cache.retryAt && (cache.fetchedAt === 0 || now - cache.fetchedAt >= REFRESH_EVERY);
}

/**
 * Download the nightly pool when due, or always with force. Returns true when a newer pool was
 * stored. A failure keeps the last good pool and tries again an hour later.
 */
export async function refreshRemote(dir: string, options: { force?: boolean; fetch?: typeof fetch; now?: number } = {}): Promise<boolean> {
	const now = options.now ?? Date.now();
	if (readConfig(dir).autoUpdate === false) return false;
	if (!options.force && !refreshDue(dir, now)) return false;
	const cache = readCache(dir);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "pool-cache.json");
	try {
		const response = await (options.fetch ?? fetch)(REMOTE_URL, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const pool = parsePool(await response.json());
		// Another pi process may have stored a newer pool while this download ran.
		if ((readCache(dir).pool?.generated ?? "") > pool.generated) return false;
		writeAtomic(file, { fetchedAt: now, retryAt: 0, pool });
		return pool.generated !== cache.pool?.generated;
	} catch {
		// Re-read: a download that succeeded meanwhile, here or in another process, wins.
		const latest = readCache(dir);
		if (latest.fetchedAt > cache.fetchedAt) return false;
		writeAtomic(file, { fetchedAt: latest.fetchedAt, retryAt: now + RETRY_AFTER, pool: latest.pool });
		return false;
	}
}
