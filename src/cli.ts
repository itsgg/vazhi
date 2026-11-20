#!/usr/bin/env node
/**
 * The vazhi command line: the router without pi. It reads and writes the same state as the pi
 * extension (pi's agent dir, PI_CODING_AGENT_DIR to move it), and takes keys from pi's auth.json
 * or the environment.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ask, AskError, callable, keyLookup } from "./ask.ts";
import { bundledPool, loadPool, refreshDue, refreshRemote, stateDir } from "./pool.ts";
import { coolingReason, emptyState, formatDuration, readyAt, Store } from "./router.ts";

const USAGE = `usage: vazhi ask [--fast] [--system TEXT] [--max-tokens N] [--json] [PROMPT...]
       vazhi status [--fast]
       vazhi reset
       vazhi update

  ask      Ask the best free model that is up and print its answer. The prompt is the
           arguments, or standard input when there are none.
           --fast        use the fast list (quick models, a second one asked when the
                         first is slow) instead of the coding pool
           --system      a system prompt
           --max-tokens  the longest answer, in tokens
           --json        print {"text", "model", "ms"} instead of the text
  status   The pool (or the fast list) and what is cooling down.
  reset    Clear every cooldown, here and in pi.
  update   Download the nightly pool now.

Keys come from pi's auth.json, then GROQ_API_KEY, GEMINI_API_KEY, NVIDIA_API_KEY and the like.
Exit status: 0 answered, 1 no model answered, 2 bad usage.`;

function version(): string {
	return JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;
}

function fail(message: string, code = 2): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/** Fetch a due pool in a detached process, so an answer never waits on GitHub. */
function refreshInBackground(dir: string): void {
	if (!refreshDue(dir)) return;
	spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "update", "--quiet"], { detached: true, stdio: "ignore" }).unref();
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "--version" || command === "-v") {
		console.log(version());
		return 0;
	}
	if (!command || command === "--help" || command === "-h" || command === "help") {
		console.log(USAGE);
		return command ? 0 : 2;
	}
	const dir = stateDir();

	if (command === "ask") {
		let parsed;
		try {
			parsed = parseArgs({
				args: rest,
				allowPositionals: true,
				options: { fast: { type: "boolean" }, system: { type: "string" }, "max-tokens": { type: "string" }, json: { type: "boolean" } },
			});
		} catch (error) {
			fail(`vazhi: ${(error as Error).message}\n${USAGE}`);
		}
		const { values, positionals } = parsed;
		const maxTokens = values["max-tokens"] === undefined ? undefined : Number(values["max-tokens"]);
		if (maxTokens !== undefined && !(Number.isInteger(maxTokens) && maxTokens > 0)) fail("vazhi: --max-tokens takes a positive whole number");
		const prompt = (positionals.length ? positionals.join(" ") : await readStdin()).trim();
		if (!prompt) fail(`vazhi: nothing to ask\n${USAGE}`);
		refreshInBackground(dir);
		const controller = new AbortController();
		process.once("SIGINT", () => controller.abort());
		try {
			const answer = await ask({ prompt, system: values.system, fast: values.fast, maxTokens, signal: controller.signal });
			process.stdout.write(values.json ? `${JSON.stringify(answer)}\n` : `${answer.text}\n`);
			return 0;
		} catch (error) {
			process.stderr.write(`${error instanceof AskError ? error.message : `vazhi: ${(error as Error).message}`}\n`);
			return 1;
		}
	}

	if (command === "status") {
		const fast = rest.includes("--fast");
		const { pool, source } = loadPool(dir, bundledPool());
		const state = new Store(dir).load();
		const key = keyLookup();
		const now = Date.now();
		const list = fast ? pool.fast : pool.pool;
		console.log(`${fast ? "fast list" : "pool"}: ${source}, generated ${pool.generated || "unknown"}`);
		list.forEach((entry, i) => {
			let status: string;
			if (!callable(entry.model, key)) status = "no key, or pi only";
			else {
				const at = readyAt(state, entry, now);
				status = at <= now ? "ready" : `cooling ${formatDuration(at - now)} (${coolingReason(state, entry, now)})`;
			}
			console.log(`${String(i + 1).padStart(2)}. ${entry.model}  ${status}`);
		});
		return 0;
	}

	if (command === "reset") {
		new Store(dir).update((state) => Object.assign(state, emptyState()));
		console.log("vazhi: cooldowns cleared");
		return 0;
	}

	if (command === "update") {
		const updated = await refreshRemote(dir, { force: !rest.includes("--quiet") });
		if (!rest.includes("--quiet")) console.log(updated ? "vazhi: fetched a newer pool" : "vazhi: pool already current, or GitHub unreachable");
		return 0;
	}

	fail(`vazhi: unknown command ${JSON.stringify(command)}\n${USAGE}`);
}

process.exitCode = await main(process.argv.slice(2));
