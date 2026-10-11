/**
 * Ranking for the nightly pool: pure functions, so the order is testable without a network.
 *
 * effective score = quality x capacity x eval
 * - quality: the Artificial Analysis coding index of the model's family when AA covers it,
 *   else the manual seed in data/seed-scores.json, else DEFAULT_SCORE.
 * - capacity: how much free use the provider gives (CAPACITY below), lower for unverified rows.
 * - eval: the weekly pi eval pass rate, when fresh, scales the score between 0.6 and 1.
 * Models that are down (scripts/rank.ts status) are left out; they are still probed every night
 * and come back once they answer.
 */

export const DEFAULT_SCORE = 10;
export const POOL_SIZE = 40;

/** Free capacity per provider, as a multiplier. From the 2026-10-11 limits review. */
export const CAPACITY: Record<string, number> = {
	nvidia: 1.0, // up to 40 RPM, no published daily cap
	kilo: 0.95, // 200 requests/hour per IP
	"zai-free": 0.9, // 1 concurrent request, no daily cap
	ovh: 0.85, // 2 RPM per model, no daily cap
	google: 0.8, // 20 RPD on Flash, 500 on Flash-Lite
	"ollama-cloud": 0.8, // small monthly starter credit
	openrouter: 0.7, // 50 free requests a day in total
	"cloudflare-workers-ai": 0.7, // 10K neurons a day
	mistral: 0.7, // free mode, limits unpublished
	llm7: 0.6, // about 100K tokens a day
};

/** Requests per minute we hold each model of a provider to. */
export const RPM: Record<string, number> = { ovh: 2 };

/**
 * One name per model family across providers and AA slugs: "Qwen3.5-397B-A17B", "qwen3-5-397b-a17b"
 * and "qwen/qwen3.5-397b-a17b:free" all become "qwen-3-5".
 */
export function family(id: string): string {
	let s = id.toLowerCase().split("/").pop() ?? "";
	s = s.replace(/:free$/, "").replace(/[:_ .]/g, "-");
	s = s.replace(/-(reasoning|non-reasoning|thinking|xhigh|high|medium|low|max|adaptive)$/, "");
	s = s.replace(/-(it|instruct|chat)$/, "");
	s = s.replace(/-\d+b-a\d+b$/, ""); // MoE size: -550b-a55b
	s = s.replace(/-(\d{4}|\d{6}|\d{8})$/, ""); // release date: -0813, -2507
	s = s.replace(/([a-z])(\d)/g, "$1-$2"); // gemma4 -> gemma-4
	return s.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export type ProbeResult = "ok" | "fail" | "limited" | "skipped";

export interface History {
	/** Most recent last; only definitive results (ok, fail) decide status. */
	[model: string]: { at: string; result: ProbeResult; ms?: number; error?: string }[];
}

export type Status = "ok" | "down" | "unverified";

/**
 * ok after a passing probe; one failure after a pass is forgiven as a blip; down after two
 * failures in a row or a failure with no pass before it; unverified when never probed.
 */
export function status(history: History[string] | undefined): Status {
	const definitive = (history ?? []).filter((h) => h.result === "ok" || h.result === "fail");
	const last = definitive.at(-1);
	if (!last) return "unverified";
	if (last.result === "ok") return "ok";
	return definitive.at(-2)?.result === "ok" ? "ok" : "down";
}

export interface EvalRecord {
	passed: number;
	total: number;
	at: string;
}

export interface Candidate {
	model: string;
	/** Whether CI can probe it tonight (a key or anonymous access). */
	probed: boolean;
}

/**
 * Add a probe result, keeping the last 10 definitive results (ok, fail) and the last 4 neutral
 * ones, so a run of rate limits cannot push out the pass that forgives a single failure.
 */
export function appendHistory(list: History[string] | undefined, entry: History[string][number]): History[string] {
	const all = [...(list ?? []), entry];
	let definitive = 0;
	let neutral = 0;
	const kept = all.reverse().filter((h) => {
		if (h.result === "ok" || h.result === "fail") return ++definitive <= 10;
		return ++neutral <= 4;
	});
	return kept.reverse();
}

export interface Ranked {
	model: string;
	rpm?: number;
	score: number;
	status: Status;
}

export function rank(
	candidates: Candidate[],
	opts: {
		history: History;
		aa: Record<string, number>;
		seeds: Record<string, number>;
		evals: Record<string, EvalRecord>;
		now: Date;
	},
): Ranked[] {
	const freshEval = (e?: EvalRecord) =>
		e && e.total >= 3 && opts.now.getTime() - Date.parse(e.at) < 21 * 24 * 3600 * 1000 ? e : undefined;
	const rows = candidates.map((c) => {
		const provider = c.model.slice(0, c.model.indexOf("/"));
		const fam = family(c.model);
		const quality = opts.aa[fam] ?? opts.seeds[fam] ?? DEFAULT_SCORE;
		// From history even when CI could not probe tonight: a missing key must not revive a dead model.
		const st = status(opts.history[c.model]);
		const capacity = (CAPACITY[provider] ?? 0.5) * (st === "unverified" ? 0.95 : 1);
		const e = freshEval(opts.evals[c.model]);
		const evalFactor = e ? 0.6 + 0.4 * (e.passed / e.total) : 1;
		const row: Ranked = { model: c.model, score: Math.round(quality * capacity * evalFactor * 10) / 10, status: st };
		if (RPM[provider]) row.rpm = RPM[provider];
		return row;
	});
	return rows
		.filter((r) => r.status !== "down")
		.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model))
		.slice(0, POOL_SIZE);
}
