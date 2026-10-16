import { normalizeFailure } from "./errors.ts";
import type { ModelAvailability } from "./models.ts";
import { formatDuration } from "./router.ts";

export interface StatusEntry {
	rank: number;
	model: string;
	availability: ModelAvailability;
}

export interface StatusInput {
	source: string;
	generated: string;
	now: number;
	entries: StatusEntry[];
	all?: boolean;
}

function rank(entry: StatusEntry): string {
	return String(entry.rank).padStart(2, "0");
}

function generatedAt(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return value || "unknown time";
	return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const FAILURE_LABEL = {
	auth: "authentication failed",
	denied: "access denied",
	minute: "minute limit",
	hourly: "hourly limit",
	daily: "daily limit",
	quota: "quota exhausted",
	gone: "model unavailable",
	slow: "response timed out",
	rate: "rate limited",
	client: "request rejected",
	other: "provider unavailable",
} as const;

function section(title: string, lines: string[]): string[] {
	return lines.length ? ["", title, ...lines] : [];
}

export function renderStatus(input: StatusInput): string {
	const groups = {
		ready: input.entries.filter((entry) => entry.availability.kind === "ready"),
		cooling: input.entries.filter((entry) => entry.availability.kind === "cooling"),
		slow: input.entries.filter((entry) => entry.availability.kind === "slow"),
		keys: input.entries.filter((entry) => entry.availability.kind === "missing-key"),
		unavailable: input.entries.filter(
			(entry) => entry.availability.kind === "missing-catalog" || entry.availability.kind === "incompatible",
		),
	};
	const counts = [
		`${groups.ready.length} ready`,
		`${groups.cooling.length} cooling`,
		`${groups.slow.length} slow`,
		`${groups.keys.length} need keys`,
		`${groups.unavailable.length} unavailable`,
	].join(" · ");
	const lines = [`vazhi · ${input.source} pool · generated ${generatedAt(input.generated)}`, `${input.entries.length} models · ${counts}`];
	lines.push(...section("READY", groups.ready.map((entry) => `  ${rank(entry)}  ${entry.model}`)));
	lines.push(
		...section(
			"COOLING",
			groups.cooling.flatMap((entry) => {
				const availability = entry.availability;
				if (availability.kind !== "cooling") return [];
				const raw = availability.reason.replace(/^[a-z]+:\s*/i, "");
				const failure = normalizeFailure(raw, entry.model.split("/", 1)[0]);
				const retry = formatDuration(Math.max(0, availability.until - input.now));
				const detail = failure.message === "provider error" ? "" : ` · ${failure.message}`;
				return [`  ${rank(entry)}  ${entry.model}`, `      ${FAILURE_LABEL[failure.kind]} · retry in ${retry}${detail}`];
			}),
		),
	);
	lines.push(
		...section(
			"SLOW, BUT AVAILABLE",
			groups.slow.map((entry) => `  ${rank(entry)}  ${entry.model}\n      tried after faster models`),
		),
	);
	if (input.all) {
		lines.push(
			...section(
				"NEEDS A KEY",
				groups.keys.map((entry) => {
					const availability = entry.availability;
					return `  ${rank(entry)}  ${entry.model}\n      /login ${availability.kind === "missing-key" ? availability.provider : ""}`;
				}),
			),
		);
	} else {
		const providers = new Map<string, number>();
		for (const entry of groups.keys) {
			const availability = entry.availability;
			if (availability.kind === "missing-key") providers.set(availability.provider, (providers.get(availability.provider) ?? 0) + 1);
		}
		lines.push(
			...section(
				"NEEDS A KEY",
				[...providers].map(([provider, count]) => `  ${provider} · ${count} model${count === 1 ? "" : "s"} · /login ${provider}`),
			),
		);
	}
	lines.push(
		...section(
			"UNAVAILABLE",
			groups.unavailable.map((entry) => {
				const availability = entry.availability;
				const reason = availability.kind === "incompatible" ? availability.reason : "not in pi's model catalogue";
				return `  ${rank(entry)}  ${entry.model}\n      ${reason}`;
			}),
		),
	);
	lines.push("", "Commands: /vazhi help");
	return lines.join("\n");
}

export function renderHelp(): string {
	return [
		"vazhi commands",
		"  /vazhi status  grouped model status (also /vazhi)",
		"  /vazhi all     status with every model that needs a key",
		"  /vazhi update  fetch the newest free-model pool",
		"  /vazhi reset   clear local cooldowns",
		"  /vazhi help    show this help",
		"",
		"Add a free provider key with /login <provider>.",
		"Configure exclude, prefer, pool, and autoUpdate in ~/.pi/agent/vazhi/config.json.",
	].join("\n");
}
