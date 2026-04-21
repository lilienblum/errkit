#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, dirname, relative, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import {
	isValidName,
	hasMarker,
	generateCode,
	renderFile,
	parseManagedFile,
	type Entry,
} from "./lib.ts";

const CATALOG_FILENAME = "errors.ts";
const MAX_WALK_DEPTH = 40;

function fail(message: string): never {
	process.stderr.write(`Error: ${message}\n`);
	process.exit(1);
}

function formatPath(path: string): string {
	const rel = relative(process.cwd(), path);
	if (rel === "") return `./${CATALOG_FILENAME}`;
	if (rel.startsWith("..")) return path;
	return `./${rel}`;
}

async function findManagedFile(startDir: string): Promise<string | null> {
	let dir = resolve(startDir);
	for (let i = 0; i < MAX_WALK_DEPTH; i++) {
		const candidate = join(dir, CATALOG_FILENAME);
		if (existsSync(candidate)) {
			const content = await readFile(candidate, "utf8");
			if (hasMarker(content)) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tmp, content);
		await rename(tmp, path);
	} catch (err) {
		try {
			await unlink(tmp);
		} catch { }
		throw err;
	}
}

function usage(): never {
	process.stderr.write(
		`Usage: errkit add NAME [--description TEXT] [-o FILE]\n`,
	);
	process.exit(1);
}

async function cmdAdd(args: string[]): Promise<void> {
	let parsed;
	try {
		parsed = parseArgs({
			args,
			options: {
				description: { type: "string", short: "d" },
				output: { type: "string", short: "o" },
			},
			allowPositionals: true,
			strict: true,
		});
	} catch (err) {
		fail((err as Error).message);
	}

	const [name, ...extra] = parsed.positionals;
	if (!name) usage();
	if (extra.length > 0) fail(`unexpected argument: ${extra[0]}`);

	if (!isValidName(name)) {
		fail(`NAME must match ^[A-Z][A-Z0-9_]*$`);
	}

	let target: string;
	let existingEntries: Entry[] = [];

	if (parsed.values.output) {
		target = resolve(parsed.values.output);
		if (existsSync(target)) {
			const content = await readFile(target, "utf8");
			if (!hasMarker(content)) {
				fail(`Found ${formatPath(target)} but it is not managed by errkit`);
			}
			try {
				existingEntries = parseManagedFile(content);
			} catch {
				fail(`Managed file ${formatPath(target)} could not be parsed`);
			}
		}
	} else {
		const found = await findManagedFile(process.cwd());
		if (found) {
			target = found;
			const content = await readFile(target, "utf8");
			try {
				existingEntries = parseManagedFile(content);
			} catch {
				fail(`Managed file ${formatPath(target)} could not be parsed`);
			}
		} else {
			target = resolve(process.cwd(), CATALOG_FILENAME);
			if (existsSync(target)) {
				fail(`Found ${formatPath(target)} but it is not managed by errkit`);
			}
		}
	}

	if (existingEntries.some((entry) => entry.name === name)) {
		fail(`${name} already exists in ${formatPath(target)}`);
	}

	const existingCodes = new Set(existingEntries.map((entry) => entry.code));
	const code = generateCode(existingCodes);

	const newEntry: Entry = { name, code };
	if (parsed.values.description) newEntry.description = parsed.values.description;

	const allEntries = [...existingEntries, newEntry];
	const rendered = renderFile(allEntries);

	try {
		await writeFileAtomic(target, rendered);
	} catch {
		fail(`Failed to write ${formatPath(target)}`);
	}

	process.stdout.write(
		`Added ${name} = ${code} to ${formatPath(target)}\n`,
	);
}

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === "add") {
		await cmdAdd(rest);
		return;
	}
	usage();
}

await main();
