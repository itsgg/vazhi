import assert from "node:assert/strict";
import { test } from "node:test";
import { windowObservations, type ObservationMessage } from "../src/observations.ts";

function tool(name: string, text: string, isError = false): ObservationMessage {
	return { role: "toolResult", toolName: name, isError, content: [{ type: "text", text }] };
}

test("older tool results collapse and the latest five stay intact", () => {
	const messages: ObservationMessage[] = [
		{ role: "user", content: [{ type: "text", text: "Keep this requirement." }] },
		...Array.from({ length: 6 }, (_, i) => tool("bash", `output ${i}`)),
	];
	const original = structuredClone(messages);
	const windowed = windowObservations(messages);
	assert.deepEqual(messages, original, "the stored transcript is not rewritten");
	assert.equal((windowed[0]!.content as { text: string }[])[0]!.text, "Keep this requirement.");
	assert.match(text(windowed[1]!), /collapsed: ok, 1 lines omitted/);
	assert.equal(text(windowed[2]!), "output 1");
	assert.equal(text(windowed[6]!), "output 5");
});

test("a long recent result keeps its ending and a broad search asks for a narrower query", () => {
	const lines = Array.from({ length: 120 }, (_, i) => `line ${i}`);
	const [result] = windowObservations([tool("grep", lines.join("\n"))], { lines: 100 });
	const body = text(result!);
	assert.match(body, /line 119/);
	assert.doesNotMatch(body, /line 0\n/);
	assert.match(body, /Narrow the query/);
});

test("image results are left unchanged even when they are old", () => {
	const image = { role: "toolResult", toolName: "read", content: [{ type: "image", data: "abc" }] };
	const messages = [image, ...Array.from({ length: 5 }, (_, i) => tool("bash", `new ${i}`))];
	assert.equal(windowObservations(messages)[0], image);
});

function text(message: ObservationMessage): string {
	const content = message.content as { text?: string }[];
	return content.map((part) => part.text ?? "").join("\n");
}
