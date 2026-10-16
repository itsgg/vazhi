import { classify, parseRetryAfter, type Kind } from "./router.ts";

export interface FailureSummary {
	kind: Kind;
	status?: number;
	message: string;
	retryAfterMs?: number;
	scope: "request" | "model" | "provider";
}

const MAX_MESSAGE = 160;
const IDS = /(account|org|organization|project|consumer|user|tenant)([_-]?id)?(["':=\s]+)[A-Za-z0-9_./-]{6,}/gi;

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function valueText(value: unknown, depth = 0): string | undefined {
	if (depth > 4) return undefined;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return undefined;
		try {
			return valueText(JSON.parse(trimmed), depth + 1) ?? trimmed;
		} catch {
			return trimmed;
		}
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null) return JSON.stringify(value);
	const object = record(value);
	if (!object) return undefined;
	const nested = record(object.error);
	for (const candidate of [nested?.message, nested?.detail, object.message, object.detail, object.error_description]) {
		const text = valueText(candidate, depth + 1);
		if (text) return text;
	}
	return JSON.stringify(object);
}

function nestedStatus(value: unknown, depth = 0): number | undefined {
	if (depth > 4) return undefined;
	const object = record(value);
	if (!object) return undefined;
	for (const candidate of [object.status, object.statusCode, object.code]) {
		if (typeof candidate === "number" && candidate >= 100 && candidate <= 599) return candidate;
		if (typeof candidate === "string" && /^[1-5]\d\d$/.test(candidate)) return Number(candidate);
	}
	for (const candidate of [object.error, object.message]) {
		if (typeof candidate === "string") {
			try {
				const found = nestedStatus(JSON.parse(candidate), depth + 1);
				if (found) return found;
			} catch {}
		} else {
			const found = nestedStatus(candidate, depth + 1);
			if (found) return found;
		}
	}
	return undefined;
}

function clean(text: string): string {
	return text
		.replace(IDS, "$1$2$3<redacted>")
		.replace(/projects?\/\d+/gi, "project/<redacted>")
		.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_MESSAGE);
}

function scope(kind: Kind): FailureSummary["scope"] {
	if (kind === "client") return "request";
	if (kind === "auth") return "provider";
	return "model";
}

export function normalizeFailure(raw: string, provider?: string): FailureSummary {
	const compact = raw.replace(/\s+/g, " ").trim();
	const leading = compact.match(/^([1-5]\d\d)\b/);
	let parsed: unknown;
	try {
		parsed = JSON.parse(compact.replace(/^[1-5]\d\d\s*/, ""));
	} catch {}
	const status = leading ? Number(leading[1]) : nestedStatus(parsed);
	const extracted = valueText(parsed);
	const message = clean(extracted ?? compact.replace(/^[1-5]\d\d\s*/, "")) || "provider error";
	const classificationText = `${status ?? ""} ${message} ${compact}`;
	const kind = classify(classificationText, provider).kind;
	const retryAfterMs = parseRetryAfter(classificationText);
	return {
		kind,
		...(status ? { status } : {}),
		message,
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		scope: scope(kind),
	};
}

const KIND_LABEL: Partial<Record<Kind, string>> = {
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
};

export function formatFailure(failure: FailureSummary): string {
	if (failure.message === "provider error") return failure.message;
	const label = KIND_LABEL[failure.kind];
	const prefix = failure.status ? `${failure.status} ` : "";
	if (!label || failure.message.toLowerCase() === label) return `${prefix}${failure.message}`.trim();
	return `${prefix}${label} · ${failure.message}`.trim();
}
