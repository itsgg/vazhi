import assert from "node:assert/strict";
import { test } from "node:test";
import { doneNote, lastAssistantText, overwriteBlock, receiptFromTool, settleDone, unsupportedClaims, type Receipt } from "../src/done.ts";

const pass = (command: string, mutates = false): Receipt => ({ kind: "command", command, exitCode: 0, mutates });
const fail = (command: string, exitCode: number | null = 1): Receipt => ({ kind: "command", command, exitCode, mutates: false });
const wrote = (path: string, ok = true): Receipt => ({ kind: "file", path, ok });

test("a pass claim with no command is unsupported", () => {
	assert.deepEqual(unsupportedClaims("All tests pass.", []), ["test"]);
});

test("a test command that exited 0 supports the claim", () => {
	assert.deepEqual(unsupportedClaims("All tests pass.", [pass("npm test")]), []);
});

test("a test that ran before the last edit does not support the claim", () => {
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("npm test"), wrote("src/a.ts")]), ["test"]);
	assert.deepEqual(unsupportedClaims("Tests passed.", [wrote("src/a.ts"), pass("npm test")]), []);
});

test("a failing or unknown exit does not support a pass claim", () => {
	assert.deepEqual(unsupportedClaims("The build passed.", [fail("npm run build", 1)]), ["build"]);
	assert.deepEqual(unsupportedClaims("The build passed.", [fail("npm run build", null)]), ["build"]);
});

test("hedged and negated sentences are not claims", () => {
	assert.deepEqual(unsupportedClaims("I should run the tests.", []), []);
	assert.deepEqual(unsupportedClaims("If tests pass, we can ship.", []), []);
	assert.deepEqual(unsupportedClaims("The tests do not pass.", []), []);
	assert.deepEqual(unsupportedClaims("I couldn't get the tests to pass.", []), []);
	assert.deepEqual(unsupportedClaims("I did not create src/a.ts.", []), []);
});

test("explicit negative-free forms are still claims", () => {
	assert.deepEqual(unsupportedClaims("No tests failed.", []), ["test"]);
	assert.deepEqual(unsupportedClaims("No type errors.", []), ["typecheck"]);
	assert.deepEqual(unsupportedClaims("No lint errors.", []), ["lint"]);
});

test("a file claim needs a successful write or edit of that path", () => {
	assert.deepEqual(unsupportedClaims("I created src/a.ts.", []), ["file:src/a.ts"]);
	assert.deepEqual(unsupportedClaims("I created src/a.ts.", [wrote("/repo/src/a.ts")]), []);
	assert.deepEqual(unsupportedClaims("I created src/a.ts.", [wrote("/repo/not-src/a.ts")]), ["file:src/a.ts"]);
	assert.deepEqual(unsupportedClaims("I created src/a.ts.", [wrote("/repo/src/a.ts", false)]), ["file:src/a.ts"]);
});

test("a command that forces exit 0 supports nothing", () => {
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("npm test || true")]), ["test"]);
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("npm test; true")]), ["test"]);
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("npm test || echo ignored")]), ["test"]);
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("npm test && true")]), []);
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("npm test; git status --short")]), ["test"]);
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("cd pkg && npm test")]), []);
});

test("a successful mutating shell command invalidates an earlier green check", () => {
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("npm test"), pass("sed -i s/a/b/ src/a.ts", true)]), ["test"]);
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("sed -i s/a/b/ src/a.ts", true), pass("npm test")]), []);
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("npm test"), { kind: "command", command: "rm x", exitCode: 1, mutates: true }]), []);
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("npm test > /tmp/test.log", true)]), []);
	assert.deepEqual(unsupportedClaims("Tests passed.", [pass("npm test"), fail("npm test")]), ["test"]);
	assert.deepEqual(unsupportedClaims("Tests passed.", [fail("npm test"), pass("npm test")]), []);
});

test("checks passed needs one real check after the last edit", () => {
	assert.deepEqual(unsupportedClaims("All checks passed.", [wrote("src/a.ts"), pass("npx tsc --noEmit")]), []);
	assert.deepEqual(unsupportedClaims("All checks passed.", [pass("ls")]), ["checks"]);
});

test("settle sends one note, then marks a repeat unverified", () => {
	const first = settleDone({
		text: "All tests pass.",
		receipts: [],
		alreadyPushed: false,
		active: true,
		outcome: "completed",
	});
	assert.equal(first.continue, true);
	assert.match(first.note ?? "", /test/);
	assert.equal(first.unverified, undefined);

	const second = settleDone({
		text: "All tests pass.",
		receipts: [],
		alreadyPushed: true,
		active: true,
		outcome: "completed",
	});
	assert.equal(second.continue, false);
	assert.equal(second.unverified, "test");
});

test("settle stays quiet when vazhi is idle, the run did not complete, or the claim is supported", () => {
	const quiet = { text: "All tests pass.", receipts: [] as Receipt[], alreadyPushed: false, active: false, outcome: "completed" as const };
	assert.deepEqual(settleDone(quiet), { continue: false });
	assert.deepEqual(settleDone({ ...quiet, active: true, outcome: "aborted" }), { continue: false });
	assert.deepEqual(settleDone({ ...quiet, active: true, receipts: [pass("pytest -q")] }), { continue: false });
});

test("settle attaches a caveat when tests pass after test files changed", () => {
	const decision = settleDone({
		text: "Tests passed.",
		receipts: [wrote("test/a.test.ts"), pass("npm test")],
		alreadyPushed: false,
		active: true,
		outcome: "completed",
	});
	assert.equal(decision.continue, false);
	assert.match(decision.caveat ?? "", /test\/a\.test\.ts/);
});

test("the note names each claim and forbids an unsupported pass", () => {
	const note = doneNote(["test", "file:src/a.ts"]);
	assert.match(note, /test/);
	assert.match(note, /src\/a\.ts/);
	assert.match(note, /exited 0/);
});

test("only the assistant's text counts, not its thinking", () => {
	assert.equal(
		lastAssistantText([
			{ role: "user", content: "All tests pass." },
			{ role: "assistant", content: [{ type: "thinking", thinking: "All tests pass." }, { type: "text", text: "I have not run them." }] },
		]),
		"I have not run them.",
	);
});

test("tool results become receipts only for shell commands and file edits", () => {
	assert.deepEqual(receiptFromTool("bash", { command: "npm test" }, false, { exit_code: 0 }), pass("npm test"));
	assert.deepEqual(receiptFromTool("powershell", { command: "npm test" }, true, { exit_code: 2 }), fail("npm test", 2));
	assert.deepEqual(receiptFromTool("bash", { command: "npm test" }, true, {}), fail("npm test", null));
	assert.deepEqual(receiptFromTool("bash", { command: "npm test" }, false, {}), pass("npm test"));
	assert.deepEqual(receiptFromTool("edit", { path: "src/a.ts" }, false, undefined), wrote("src/a.ts"));
	assert.deepEqual(receiptFromTool("read", { path: "src/a.ts" }, false, undefined), { kind: "read", path: "src/a.ts" });
	assert.equal(receiptFromTool("read", { path: "src/a.ts" }, true, undefined), null);
	assert.equal(receiptFromTool("bash", {}, false, { exit_code: 0 }), null);
});

test("write cannot replace an existing file this run has not read", () => {
	const exists = (path: string) => path === "src/a.ts" || path === "/repo/src/a.ts";
	assert.match(overwriteBlock("write", { path: "src/a.ts" }, [], exists) ?? "", /src\/a\.ts/);
	assert.equal(overwriteBlock("write", { path: "src/a.ts" }, [{ kind: "read", path: "/repo/src/a.ts" }], exists), undefined);
	assert.equal(overwriteBlock("write", { path: "src/new.ts" }, [], () => false), undefined);
	assert.equal(overwriteBlock("edit", { path: "src/a.ts" }, [], exists), undefined);
	assert.equal(overwriteBlock("write", { path: "src/a.ts" }, [{ kind: "read", path: "/repo/not-src/a.ts" }], exists) !== undefined, true);
});

test("a mutation after a read expires whole-file overwrite authorization", () => {
	const receipts: Receipt[] = [{ kind: "read", path: "src/a.ts" }, wrote("src/a.ts")];
	assert.match(overwriteBlock("write", { path: "src/a.ts" }, receipts, () => true) ?? "", /read src\/a\.ts/);
	assert.equal(overwriteBlock("write", { path: "src/a.ts" }, [...receipts, { kind: "read", path: "src/a.ts" }], () => true), undefined);
	assert.match(
		overwriteBlock("write", { path: "src/a.ts" }, [{ kind: "read", path: "src/a.ts" }, pass("cp x y", true)], () => true) ?? "",
		/read src\/a\.ts/,
	);
});

test("shell receipt identifies conservative mutation forms", () => {
	for (const command of [
		"echo x > src/a.ts",
		"cat x >> src/a.ts",
		"cat x | tee src/a.ts",
		"sed -i s/a/b/ src/a.ts",
		"perl -pi -e s/a/b/ src/a.ts",
		"patch -p1 < fix.patch",
		"git apply fix.patch",
		"rm src/a.ts",
		"mv a b",
		"cp a b",
		"truncate -s 0 a",
	]) {
		assert.equal((receiptFromTool("bash", { command }, false, { exit_code: 0 }) as any)?.mutates, true, command);
	}
	assert.equal((receiptFromTool("bash", { command: "npm test" }, false, { exit_code: 0 }) as any)?.mutates, false);
});

test("labeled replies: every false done is caught and every honest reply is left alone", () => {
	const rows: { text: string; receipts: Receipt[]; falseDone: boolean }[] = [
		{ text: "All tests pass.", receipts: [], falseDone: true },
		{ text: "Tests passed.", receipts: [pass("npm test"), wrote("src/a.ts")], falseDone: true },
		{ text: "Tests passed.", receipts: [fail("npm test")], falseDone: true },
		{ text: "The build succeeded.", receipts: [], falseDone: true },
		{ text: "I created src/new.ts", receipts: [], falseDone: true },
		{ text: "Typecheck passes.", receipts: [fail("npx tsc --noEmit", 2)], falseDone: true },
		{ text: "I ran the tests and they pass.", receipts: [pass("ls")], falseDone: true },
		{ text: "Lint is clean.", receipts: [], falseDone: true },
		{ text: "Tests passed.", receipts: [wrote("src/a.ts"), pass("npm test")], falseDone: false },
		{ text: "I created src/new.ts.", receipts: [wrote("src/new.ts")], falseDone: false },
		{ text: "Tests failed, I'll look again.", receipts: [], falseDone: false },
		{ text: "I should run the tests.", receipts: [], falseDone: false },
		{ text: "The tests might pass.", receipts: [], falseDone: false },
		{ text: "I read the file and the function is named foo.", receipts: [], falseDone: false },
		{ text: "Couldn't get the tests to pass.", receipts: [], falseDone: false },
		{ text: "Build passed.", receipts: [pass("npm run build")], falseDone: false },
		{ text: "I updated src/a.ts and the tests pass.", receipts: [wrote("src/a.ts"), pass("npm test")], falseDone: false },
		{ text: "No type errors.", receipts: [pass("npm run typecheck")], falseDone: false },
		{ text: "Tests are passing.", receipts: [], falseDone: true },
		{ text: "The test suite passed.", receipts: [], falseDone: true },
		{ text: "I wrote `src/new.ts`.", receipts: [], falseDone: true },
		{ text: "All tests passed successfully.", receipts: [], falseDone: true },
		{ text: "I fixed the null check.", receipts: [], falseDone: false },
		{ text: "Tests that pass the filter are kept.", receipts: [], falseDone: false },
	];
	let caught = 0;
	let missed = 0;
	let falseAlarm = 0;
	let allowed = 0;
	const misses: string[] = [];
	const alarms: string[] = [];
	for (const row of rows) {
		const got = unsupportedClaims(row.text, row.receipts);
		if (row.falseDone) {
			if (got.length > 0) caught++;
			else {
				missed++;
				misses.push(row.text);
			}
		} else if (got.length > 0) {
			falseAlarm++;
			alarms.push(`${row.text} -> ${got.join(",")}`);
		} else allowed++;
	}
	assert.equal(
		missed + falseAlarm,
		0,
		`caught ${caught}, missed ${missed} (${misses.join(" | ")}), false alarms ${falseAlarm} (${alarms.join(" | ")}), allowed ${allowed}`,
	);
});
