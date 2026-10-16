/**
 * Deterministic tool-output window. Recent observations stay intact up to a line budget.
 * Older ones collapse to a one-line record. Nothing here calls a model.
 */

export interface ObservationMessage {
	role?: string;
	toolName?: string;
	isError?: boolean;
	content?: unknown;
}

export interface WindowOptions {
	keep?: number;
	lines?: number;
}

const SEARCH = /^(?:grep|rg|find|search|glob)$/i;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const record = part as { type?: unknown; text?: unknown };
			return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
		})
		.join("\n");
}

function hasImage(content: unknown): boolean {
	return Array.isArray(content) && content.some((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "image");
}

function withText<T extends ObservationMessage>(message: T, text: string): T {
	return { ...message, content: [{ type: "text", text }] };
}

export function windowObservations<T extends ObservationMessage>(messages: readonly T[], options: WindowOptions = {}): T[] {
	const keep = options.keep ?? 5;
	const budget = options.lines ?? 100;
	const toolIndexes = messages.flatMap((message, index) => (message.role === "toolResult" ? [index] : []));
	const recent = new Set(toolIndexes.slice(-keep));
	return messages.map((message, index) => {
		if (message.role !== "toolResult" || hasImage(message.content)) return message;
		const lines = textOf(message.content).split("\n");
		if (!recent.has(index)) {
			const outcome = message.isError ? "error" : "ok";
			return withText(message, `[Earlier ${message.toolName ?? "tool"} result collapsed: ${outcome}, ${lines.length} lines omitted.]`);
		}
		if (lines.length <= budget) return message;
		const omitted = lines.length - budget;
		const tail = SEARCH.test(message.toolName ?? "")
			? `[vazhi: ${omitted} lines omitted. Narrow the query.]`
			: `[vazhi: ${omitted} lines omitted.]`;
		return withText(message, `${lines.slice(-budget).join("\n")}\n${tail}`);
	});
}
