import { coolingReason, isGemini3, readyAt, splitKey, type PoolEntry, type SignatureConstraint, type State } from "./router.ts";

export type ModelAvailability =
	| { kind: "ready" }
	| { kind: "slow"; until: number }
	| { kind: "cooling"; until: number; reason: string }
	| { kind: "missing-key"; provider: string }
	| { kind: "missing-catalog" }
	| { kind: "incompatible"; reason: string };

export interface ModelRegistryView {
	find(provider: string, id: string): unknown;
	hasConfiguredAuth(model: unknown): boolean;
}

function incompatibility(entry: PoolEntry, constraint: SignatureConstraint): string | undefined {
	const { provider, id } = splitKey(entry.model);
	if (provider !== "google" || !isGemini3(id) || constraint.mode === "unrestricted") return undefined;
	if (constraint.mode === "blocked") return "Gemini thought signature belongs to another model";
	if (entry.model !== constraint.model) return `conversation is signed for ${constraint.model}`;
	return undefined;
}

export function modelAvailability(
	entry: PoolEntry,
	state: State,
	now: number,
	registry: ModelRegistryView,
	constraint: SignatureConstraint,
): ModelAvailability {
	const { provider, id } = splitKey(entry.model);
	const model = registry.find(provider, id);
	if (!model) return { kind: "missing-catalog" };
	if (!registry.hasConfiguredAuth(model)) return { kind: "missing-key", provider };
	const incompatible = incompatibility(entry, constraint);
	if (incompatible) return { kind: "incompatible", reason: incompatible };
	const at = readyAt(state, entry, now);
	if (at > now) return { kind: "cooling", until: at, reason: coolingReason(state, entry, now) ?? "locally paced" };
	const slowUntil = state.slow[entry.model] ?? 0;
	if (slowUntil > now) return { kind: "slow", until: slowUntil };
	return { kind: "ready" };
}
