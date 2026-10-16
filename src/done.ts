/**
 * A finishing claim counts only when a tool receipt supports it. The model proposes the
 * sentence; this module decides. One unsupported claim can send the run back once.
 */

export type Receipt =
	| { kind: "command"; command: string; exitCode: number | null; mutates: boolean }
	| { kind: "file"; path: string; ok: boolean }
	| { kind: "read"; path: string };

const HEDGE = /\b(?:if|should|might|may|would|could|unless|until|hopefully|assuming)\b/i;
const NEGATION = /\b(?:not|never|cannot|can't|couldn't|unable|didn't|don't|does not|do not|without)\b/i;
const FORCED = /(?:\|\|\s*(?:true|:|exit\s+0|(?:echo|printf)\b[^;&|]*)|;\s*(?:true|:|exit\s+0))\s*$/;
const SHELL_MUTATION =
	/(?:^|[;&|]\s*)(?:rm|mv|cp|truncate|patch)\b|(?:^|[;&|]\s*)git\s+apply\b|(?:^|[;&|]\s*)tee\b|\b(?:sed|perl)\b[^;&|\n]*\s-(?:[A-Za-z]*i[A-Za-z]*)(?:\s|$)|(?:^|[^<])>>?\s*\S/;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.go$/i;

const PASS: Record<"test" | "build" | "typecheck" | "lint" | "checks", RegExp> = {
	test: /\btests?\b(?!\s+that\b)(?!\s+which\b)(?:\s+\w+){0,6}\s+(?:pass(?:ed|es)?|succeed(?:ed)?)\b|\btests?\s+(?:are|were)\s+(?:all\s+)?(?:green|passing)\b|\bno\s+tests?\s+failed\b/i,
	build: /\bbuild\s+(?:now\s+|has\s+|is\s+)?(?:pass(?:ed|es)?|succeed(?:ed)?|clean)\b/i,
	typecheck: /\btype\s*-?\s*checks?\s+(?:now\s+|has\s+)?(?:pass(?:ed|es)?|succeed(?:ed)?)\b|\bno\s+type\s+errors?\b/i,
	lint: /\blint(?:er|ing)?\s+(?:now\s+|has\s+|is\s+)?(?:pass(?:ed|es)?|clean)\b|\bno\s+lint\s+(?:errors?|issues?)\b/i,
	checks: /\b(?:all\s+)?checks?\s+(?:now\s+|have\s+)?pass(?:ed|es)?\b/i,
};

const COMMAND: Record<"test" | "build" | "typecheck" | "lint", RegExp> = {
	test: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnpx\s+(?:vitest|jest)\b|\b(?:pytest|py\.test|vitest|jest|cargo\s+test|go\s+test|mix\s+test|phpunit|rspec|ctest|mvn\s+test|gradle\s+test|dotnet\s+test)\b/i,
	build: /\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b|\b(?:cargo\s+build|go\s+build|mvn\s+package|gradle\s+build)\b/i,
	typecheck: /\btsc\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+typecheck\b|\b(?:mypy|pyright|vue-tsc)\b/i,
	lint: /\b(?:eslint|ruff|biome)\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+lint\b|\bcargo\s+clippy\b/i,
};

const FILE = /(?:created|wrote|written|added)\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?[`'"]?((?:[A-Za-z0-9_.@~+-]+\/)*[A-Za-z0-9_.@~+-]+\.[A-Za-z0-9]+)/gi;

const ORDER = ["test", "build", "typecheck", "lint", "checks"] as const;

export function unsupportedClaims(text: string, receipts: Receipt[]): string[] {
	const found: string[] = [];
	for (const sentence of text.split(/\n+|(?<=[.!?])\s+/)) {
		const trimmed = sentence.trim();
		if (trimmed === "" || HEDGE.test(trimmed)) continue;
		const here: string[] = [];
		for (const kind of ORDER) {
			if (PASS[kind].test(trimmed)) here.push(kind);
		}
		if (!NEGATION.test(trimmed)) {
			for (const match of trimmed.matchAll(FILE)) {
				const path = match[1];
				if (path) here.push(`file:${path}`);
			}
		} else {
			// "no tests failed" and its siblings are real claims; other negations are not.
			for (let i = here.length - 1; i >= 0; i--) {
				const kind = here[i];
				if (kind === "test" && !/\bno\s+tests?\s+failed\b/i.test(trimmed)) here.splice(i, 1);
				if (kind === "typecheck" && !/\bno\s+type\s+errors?\b/i.test(trimmed)) here.splice(i, 1);
				if (kind === "lint" && !/\bno\s+lint\s+(?:errors?|issues?)\b/i.test(trimmed)) here.splice(i, 1);
				if (kind === "build" || kind === "checks" || kind?.startsWith("file:")) here.splice(i, 1);
			}
		}
		for (const claim of here) {
			if (!found.includes(claim)) found.push(claim);
		}
	}
	return found.filter((claim) => !supported(claim, receipts));
}

export function doneNote(claims: string[]): string {
	const lines = claims.map((claim) => (claim.startsWith("file:") ? `- created ${claim.slice(5)}` : `- ${claim} passed`));
	return [
		"vazhi: these claims have no supporting tool result in this turn:",
		...lines,
		"Run the check after the last edit and use its exit code, or delete the claim. Do not say it passed unless a matching command exited 0.",
	].join("\n");
}

export function settleDone(input: {
	text: string;
	receipts: Receipt[];
	alreadyPushed: boolean;
	active: boolean;
	outcome: "completed" | "aborted" | "error";
}): { continue: boolean; note?: string; unverified?: string; caveat?: string } {
	if (!input.active || input.outcome !== "completed") return { continue: false };
	const claims = unsupportedClaims(input.text, input.receipts);
	if (claims.length === 0) return { continue: false, ...(testEditCaveat(input.text, input.receipts) ? { caveat: testEditCaveat(input.text, input.receipts) } : {}) };
	if (input.alreadyPushed) return { continue: false, unverified: claims.join(", ") };
	return { continue: true, note: doneNote(claims) };
}

export function receiptFromTool(toolName: string, input: unknown, isError: boolean, structured: unknown): Receipt | null {
	const fields = input !== null && typeof input === "object" ? (input as { command?: unknown; path?: unknown }) : {};
	if (toolName === "bash" || toolName === "powershell") {
		if (typeof fields.command !== "string" || fields.command === "") return null;
		return {
			kind: "command",
			command: fields.command,
			exitCode: exitCode(structured, isError),
			mutates: SHELL_MUTATION.test(fields.command),
		};
	}
	if (toolName === "write" || toolName === "edit") {
		if (typeof fields.path !== "string" || fields.path === "") return null;
		return { kind: "file", path: fields.path, ok: !isError };
	}
	if (toolName === "read") {
		if (isError || typeof fields.path !== "string" || fields.path === "") return null;
		return { kind: "read", path: fields.path };
	}
	return null;
}

/**
 * write replaces the whole file. An edit has to match text that is already there, so a guess fails.
 * A write of an existing file is allowed only after this run has read that file.
 */
export function overwriteBlock(
	toolName: string,
	input: unknown,
	receipts: Receipt[],
	exists: (path: string) => boolean,
): string | undefined {
	if (toolName !== "write") return undefined;
	const fields = input !== null && typeof input === "object" ? (input as { path?: unknown }) : {};
	const path = fields.path;
	if (typeof path !== "string" || path === "") return undefined;
	let lastRead = -1;
	let lastMutation = -1;
	for (let i = 0; i < receipts.length; i++) {
		const receipt = receipts[i];
		if (receipt?.kind === "read" && pathsMatch(path, receipt.path)) lastRead = i;
		if (receipt?.kind === "file" && receipt.ok && pathsMatch(path, receipt.path)) lastMutation = i;
		if (receipt?.kind === "command" && receipt.exitCode === 0 && receipt.mutates) lastMutation = i;
	}
	const seen = lastRead > lastMutation;
	if (seen || !exists(path)) return undefined;
	return `vazhi: read ${path} before overwriting it. write replaces the whole file.`;
}

export function lastAssistantText(messages: readonly { role?: string; content?: unknown }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") return textFromContent(message.content);
	}
	return "";
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const record = part as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n");
}

function supported(claim: string, receipts: Receipt[]): boolean {
	if (claim.startsWith("file:")) return fileSupported(claim.slice(5), receipts);
	if (claim === "checks") return (["test", "build", "typecheck", "lint"] as const).some((kind) => commandSupports(kind, receipts));
	if (claim === "test" || claim === "build" || claim === "typecheck" || claim === "lint") return commandSupports(claim, receipts);
	return false;
}

function lastStatusSegment(command: string): string {
	const parts = command.split(/[;\n]/).map((part) => part.trim()).filter(Boolean);
	const segment = parts.at(-1) ?? "";
	return segment.includes("|") ? (segment.split("|").at(-1)?.trim() ?? "") : segment;
}

/** The shell's exit code belongs to this check, not to a later command or a forced success. */
function countsAsCheck(command: string, kind: "test" | "build" | "typecheck" | "lint"): boolean {
	return !FORCED.test(command) && COMMAND[kind].test(lastStatusSegment(command));
}

function commandSupports(kind: "test" | "build" | "typecheck" | "lint", receipts: Receipt[]): boolean {
	const after = lastMutation(receipts);
	let supported = false;
	for (let index = 0; index < receipts.length; index++) {
		const receipt = receipts[index];
		if (receipt?.kind !== "command" || !countsAsCheck(receipt.command, kind)) continue;
		const ownOutput = index === after && receipt.mutates;
		if (index < after || (index === after && !ownOutput)) continue;
		supported = receipt.exitCode === 0;
	}
	return supported;
}

function lastMutation(receipts: Receipt[]): number {
	let at = -1;
	for (let i = 0; i < receipts.length; i++) {
		const receipt = receipts[i];
		if (receipt?.kind === "file" && receipt.ok) at = i;
		if (receipt?.kind === "command" && receipt.exitCode === 0 && receipt.mutates) at = i;
	}
	return at;
}

function testEditCaveat(text: string, receipts: Receipt[]): string | undefined {
	if (!PASS.test.test(text)) return undefined;
	for (let i = 0; i < receipts.length; i++) {
		const receipt = receipts[i];
		if (receipt?.kind !== "file" || !receipt.ok || !TEST_PATH.test(receipt.path)) continue;
		const passedLater = receipts.slice(i + 1).some(
			(later) => later.kind === "command" && later.exitCode === 0 && countsAsCheck(later.command, "test"),
		);
		if (passedLater) return `vazhi: tests exited 0 after this run changed ${receipt.path}; the result includes modified tests.`;
	}
	return undefined;
}

function fileSupported(path: string, receipts: Receipt[]): boolean {
	return receipts.some((receipt) => receipt.kind === "file" && receipt.ok && pathsMatch(path, receipt.path));
}

function pathsMatch(claimed: string, actual: string): boolean {
	const claim = claimed.replace(/\\/g, "/").replace(/^\.\//, "");
	const have = actual.replace(/\\/g, "/").replace(/^\.\//, "");
	return have === claim || have.endsWith(`/${claim}`);
}

function exitCode(structured: unknown, isError: boolean): number | null {
	if (typeof structured === "object" && structured !== null && "exit_code" in structured) {
		const code = (structured as { exit_code?: unknown }).exit_code;
		if (typeof code === "number" && Number.isFinite(code)) return code;
	}
	return isError ? null : 0;
}
