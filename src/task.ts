import type { PoolEntry } from "./router.ts";
import type { TaskClassModels } from "./pool.ts";

export type TaskClass = "bugfix" | "edit" | "answer";

/** Classify the latest user text. A missing table leaves the pool order alone. */
export function taskClass(text: string): TaskClass {
	const body = text.toLowerCase();
	if (/\b(test|tests|pytest|unittest)\b/.test(body) && /\b(fail|fails|failed|fix|broken)\b/.test(body)) return "bugfix";
	if (/\b(rename|refactor|edit|change|implement|add)\b/.test(body)) return "edit";
	return "answer";
}

export function orderForClass(entries: PoolEntry[], kind: TaskClass, table?: TaskClassModels): PoolEntry[] {
	const preferred = table?.[kind];
	if (!preferred) return entries;
	const front = entries.filter((entry) => entry.model === preferred);
	if (!front.length) return entries;
	return [...front, ...entries.filter((entry) => entry.model !== preferred)];
}

export function lastUserText(messages: readonly { role?: string; content?: unknown }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content
				.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
				.join("\n");
		}
	}
	return "";
}
