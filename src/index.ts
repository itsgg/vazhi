/**
 * vazhi: the virtual model vazhi/auto sends each request to the best free model that is up, and
 * reroutes when a provider rate-limits, runs out of quota, hangs or fails.
 *
 * Pi retries rate limits and 5xx on its own and calls route() with reason "retry", which then
 * skips the model that failed. Quota, auth and 404 errors are not retryable for pi, so the
 * message_end handler tags them as unavailable, which makes pi retry and lets route() move on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPool, parsePool, refreshDue, refreshRemote, type PoolFile } from "./pool.ts";
import { ANONYMOUS_KEY, OWN_PROVIDERS } from "./providers.ts";
import {
	choose,
	classify,
	clientReroute,
	coolingReason,
	emptyState,
	formatDuration,
	keyOf,
	penalize,
	pickWithin,
	readyAt,
	recover,
	reserve,
	SECOND,
	splitKey,
	Store,
	type Kind,
	type PoolEntry,
} from "./router.ts";

const PROVIDER = "vazhi";
const ID = "auto";
const MARKER = "[vazhi: service unavailable, rerouting]";
/**
 * When every model is cooling, route() waits this long in total for the first to free up. Over a
 * minute, so a model paced by its rpm cap (OVH: 2 a minute) always gets its next slot.
 */
const MAX_WAIT = 65 * SECOND;

/**
 * The replacement for a failed message, or undefined to leave it: pi already retries it. Pi never
 * retries some quota wordings even with the marker, so those move to /vazhi and the message says
 * only what failed.
 */
export function retryable(message: AssistantMessage, key: string, kind: Kind, ms: number): AssistantMessage | undefined {
	if (isRetryableAssistantError(message)) return undefined;
	const tagged = { ...message, errorMessage: `${message.errorMessage ?? ""} ${MARKER}` };
	if (isRetryableAssistantError(tagged)) return tagged;
	return { ...message, errorMessage: `${key} failed (${kind}), cooling ${formatDuration(ms)}, details in /vazhi ${MARKER}` };
}

/** Drop the anonymous placeholder so keyless providers get no Authorization header; a real key stays. */
export function stripAnonymous(headers: Record<string, string | null>): void {
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() === "authorization" && headers[name] === `Bearer ${ANONYMOUS_KEY}`) headers[name] = null;
	}
}

function readBundled(): PoolFile {
	return parsePool(JSON.parse(readFileSync(fileURLToPath(new URL("../pool.json", import.meta.url)), "utf8")));
}

function registerProviders(pi: ExtensionAPI, pool: PoolFile): void {
	for (const [id, provider] of Object.entries(OWN_PROVIDERS)) {
		pi.registerProvider(id, {
			name: provider.name,
			baseUrl: provider.baseUrl,
			api: "openai-completions",
			...(provider.anonymous ? { apiKey: ANONYMOUS_KEY, authHeader: true } : {}),
			models: (pool.models[id] ?? []).map((m) => ({
				...m,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: provider.compat as Model<Api>["compat"],
			})),
		});
	}
}

function credentialed(ctx: ExtensionContext, pool: PoolEntry[]): { entry: PoolEntry; model: Model<Api> }[] {
	return pool.flatMap((entry) => {
		const { provider, id } = splitKey(entry.model);
		const model = ctx.modelRegistry.find(provider, id);
		return model && ctx.modelRegistry.hasConfiguredAuth(model) ? [{ entry, model }] : [];
	});
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("vazhi: aborted"));
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("vazhi: aborted"));
			},
			{ once: true },
		);
	});
}

export default function (pi: ExtensionAPI) {
	const dir = join(getAgentDir(), "vazhi");
	const store = new Store(dir);
	const bundled = readBundled();
	const current = () => loadPool(dir, bundled);
	registerProviders(pi, current().pool);

	// One pool per turn: a pool downloaded mid-turn takes effect at the next turn, so the models a
	// turn routes between, and the providers registered for them, never change under it.
	let turn = current();
	let downloaded = false;
	const startTurn = () => {
		if (downloaded) {
			downloaded = false;
			registerProviders(pi, current().pool);
		}
		turn = current();
	};

	// Checked at every session start and every turn, so a session left open for days still picks up
	// the nightly pool. In the background, and one download at a time in this process, forced or
	// not; a fresh copy costs two small reads.
	let downloading: Promise<boolean> | undefined;
	const download = (force = false): Promise<boolean> => {
		if (downloading) return force ? downloading.then(() => download(true)) : downloading;
		if (!force && !refreshDue(dir)) return Promise.resolve(false);
		downloading = refreshRemote(dir, { force })
			.then((updated) => {
				if (updated) downloaded = true;
				return updated;
			})
			.catch(() => false)
			.finally(() => {
				downloading = undefined;
			});
		return downloading;
	};

	pi.registerVirtualModel({
		provider: PROVIDER,
		id: ID,
		name: "vazhi: best free model that is up",
		thinkingLevels: ["off", "low", "medium", "high"],
		contextWindow: 128_000,
		maxTokens: 32_768,
		async route(request, ctx) {
			if (request.reason === "user") {
				startTurn();
				void download();
			}
			const previous = request.reason === "continuation" && request.previous ? keyOf(request.previous.model) : undefined;
			const failed = request.reason === "retry" && request.failed ? keyOf(request.failed.model) : undefined;
			// Credentials are rechecked on every attempt; the pool stays the turn's.
			let candidates: { entry: PoolEntry; model: Model<Api> }[] = [];
			const choice = await pickWithin(
				() => {
					candidates = credentialed(ctx, turn.pool.pool);
					if (candidates.length === 0) throw new Error("vazhi: no pool model has credentials; run /vazhi to see the pool");
					const entries = candidates.map((c) => c.entry);
					return store.update((state) => {
						const now = Date.now();
						const c = choose(entries, state, now, previous, failed);
						if (c.pick) reserve(state, c.pick, now);
						return c;
					});
				},
				MAX_WAIT,
				(ms) => sleep(ms, request.signal),
			);
			if (!choice.pick) {
				throw new Error(
					`vazhi: every model with a key is cooling down; the first back is ${choice.next.model}, ` +
						`in ${formatDuration(choice.waitMs)}. Add keys with /login, or clear cooldowns with /vazhi reset.`,
				);
			}
			const model = candidates.find((c) => c.entry === choice.pick)!.model;
			return { model, thinkingLevel: request.thinkingLevel };
		},
	});

	pi.on("session_start", () => {
		startTurn();
		void download();
	});

	let clientReroutes: number[] = [];
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason === "aborted") return;
		// With vazhi/auto selected, every physical response came from route(), even for a model a
		// pool update has since removed, so no pool lookup here.
		if (ctx.model?.provider !== PROVIDER || ctx.model?.id !== ID) return;
		const key = `${message.provider}/${message.model}`;

		if (message.stopReason !== "error") {
			store.update((state) => recover(state, key, message.timestamp));
			return;
		}
		const physical = ctx.modelRegistry.find(message.provider, message.model);
		if (isContextOverflow(message, physical?.contextWindow ?? 0)) return;

		const text = message.errorMessage ?? "";
		const rule = classify(text);
		if (rule.kind === "client") {
			const next = clientReroute(clientReroutes, Date.now());
			if (!next) return;
			clientReroutes = next;
		}
		const ms = store.update((state) => penalize(state, key, text, Date.now(), turn.pool.sharedLimits));
		if (ctx.hasUI) ctx.ui.notify(`vazhi: ${key} cooling for ${formatDuration(ms)}, rerouting`, "warning");
		const replacement = retryable(message, key, rule.kind, ms);
		return replacement ? { message: replacement } : undefined;
	});

	pi.on("before_provider_headers", (event) => stripAnonymous(event.headers));

	pi.registerCommand("vazhi", {
		description: "Show the free model pool and cooldowns; /vazhi reset clears cooldowns, /vazhi update fetches the nightly pool",
		getArgumentCompletions: (prefix) =>
			["reset", "update"].filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "reset") {
				store.update((state) => Object.assign(state, emptyState()));
				ctx.ui.notify("vazhi: cooldowns cleared", "info");
				return;
			}
			if (arg === "update") {
				const updated = await download(true);
				startTurn();
				ctx.ui.notify(updated ? "vazhi: fetched a newer pool" : "vazhi: pool already current, or GitHub unreachable", "info");
				return;
			}
			const now = Date.now();
			const state = store.load();
			const { pool, source } = current();
			const lines = pool.pool.map((entry, i) => {
				const { provider, id } = splitKey(entry.model);
				const model = ctx.modelRegistry.find(provider, id);
				let status: string;
				if (!model) status = "not in catalog";
				else if (!ctx.modelRegistry.hasConfiguredAuth(model)) status = "no key";
				else {
					const at = readyAt(state, entry, now);
					status = at <= now ? "ready" : `cooling ${formatDuration(at - now)} (${coolingReason(state, entry, now)})`;
				}
				return `${String(i + 1).padStart(2)}. ${entry.model}  ${status}`;
			});
			ctx.ui.notify([`pool: ${source}, generated ${pool.generated || "unknown"}`, ...lines].join("\n"), "info");
		},
	});
}
