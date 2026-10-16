import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE = /\.(ts|tsx|js|mjs|py|go|rs)$/;
const SIGNATURE = /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|def|fn|func)\s+\w+/;
const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);

/**
 * A short list of source signatures. Returns undefined when the tree has none.
 * The caller decides whether to show it; this function only reads and caps.
 */
export function repositoryMap(root: string, options?: { maxFiles?: number; maxLines?: number }): string | undefined {
	const maxFiles = options?.maxFiles ?? 12;
	const maxLines = options?.maxLines ?? 40;
	const lines: string[] = [];
	for (const file of sourceFiles(root, maxFiles)) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const found = text
			.split("\n")
			.slice(0, 200)
			.filter((line) => SIGNATURE.test(line.trim()))
			.slice(0, 8);
		for (const signature of found) {
			if (lines.length >= maxLines) return lines.join("\n");
			lines.push(`${relative(root, file)}: ${signature.trim()}`);
		}
	}
	return lines.length ? lines.join("\n") : undefined;
}

function sourceFiles(root: string, maxFiles: number): string[] {
	if (SKIP.has(root.split("/").at(-1) ?? "")) return [];
	const found: string[] = [];
	const queue = [root];
	while (queue.length && found.length < maxFiles) {
		const dir = queue.shift();
		if (!dir) break;
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			continue;
		}
		const dirs: string[] = [];
		for (const name of names) {
			if (SKIP.has(name)) continue;
			const path = join(dir, name);
			let info: ReturnType<typeof lstatSync>;
			try {
				info = lstatSync(path);
			} catch {
				continue;
			}
			if (info.isSymbolicLink()) continue;
			if (info.isDirectory()) dirs.push(path);
			else if (SOURCE.test(name) && found.length < maxFiles) found.push(path);
		}
		queue.push(...dirs);
	}
	return found;
}
