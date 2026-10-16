import assert from "node:assert/strict";
import { test } from "node:test";
import { lastUserText, orderForClass, taskClass } from "../src/task.ts";

test("task class follows the user text and an empty table does not reorder", () => {
	assert.equal(taskClass("The tests fail. Fix the assertion."), "bugfix");
	assert.equal(taskClass("Rename the helper and update its callers."), "edit");
	assert.equal(taskClass("What does note.txt say?"), "answer");
	const entries = [{ model: "ovh/first" }, { model: "kilo/second" }];
	assert.deepEqual(orderForClass(entries, "bugfix"), entries);
	assert.deepEqual(orderForClass(entries, "bugfix", {}), entries);
	assert.deepEqual(orderForClass(entries, "bugfix", { bugfix: "missing/model" }), entries);
	assert.deepEqual(orderForClass(entries, "bugfix", { bugfix: "kilo/second" }).map((entry) => entry.model), ["kilo/second", "ovh/first"]);
	assert.equal(lastUserText([{ role: "assistant", content: "no" }, { role: "user", content: [{ type: "text", text: "Add a flag" }] }]), "Add a flag");
});
