#!/usr/bin/env node
import { resolve, dirname, relative, join, basename } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import {
	parseConfig,
	backfillCodes,
	collectEntries,
	renderTs,
	renderGo,
	hasMarker,
	markerFor,
	langFromPath,
	type Config,
	type Output,
} from "./lib.ts";

const CONFIG_FILENAME = "errkit.jsonc";
const MAX_WALK_DEPTH = 40;

const SCHEMA_URL = "https://unpkg.com/errkit@latest/schema.json";

const STARTER = `// errkit configuration.
// Edit this file by hand, then run \`errkit generate\` to write the output files.
// Codes are auto-generated and filled in when you run \`errkit generate\`.

{
  "$schema": "${SCHEMA_URL}",

  // Files to generate. Language is inferred from the file extension (.ts or .go).
  // Each output emits \`common\` entries plus any listed scopes.
  "outputs": [
    // { "path": "src/errors.ts" },
    // { "path": "internal/errs/errors.go", "scopes": ["server"] }
  ],

  // Errors included in every output. \`description\` is optional.
  "common": {
    // "USER_NOT_AUTHORIZED": { "description": "User is not authorized" },
    // "PAYMENT_FAILED": {}
  },

  // Named groups of errors. Outputs opt in by listing a scope name.
  "scopes": {
    // "server": {
    //   "DATABASE_UNAVAILABLE": { "description": "Database is unavailable" }
    // }
  }
}
`;

function fail(message: string): never {
	process.stderr.write(`Error: ${message}\n`);
	process.exit(1);
}

function formatPath(path: string): string {
	const rel = relative(process.cwd(), path);
	if (rel === "") return `./${basename(path)}`;
	if (rel.startsWith("..")) return path;
	return `./${rel}`;
}

async function findConfig(startDir: string): Promise<string | null> {
	let dir = resolve(startDir);
	for (let i = 0; i < MAX_WALK_DEPTH; i++) {
		const candidate = join(dir, CONFIG_FILENAME);
		if (existsSync(candidate)) return candidate;
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
		`Usage:
  errkit init              Create errkit.jsonc in the current directory
  errkit generate          Read errkit.jsonc, backfill codes, write output files
                           (aliases: gen, g)
`,
	);
	process.exit(1);
}

async function cmdInit(): Promise<void> {
	const target = resolve(process.cwd(), CONFIG_FILENAME);
	if (existsSync(target)) {
		fail(`${formatPath(target)} already exists`);
	}
	try {
		await writeFileAtomic(target, STARTER);
	} catch {
		fail(`Failed to write ${formatPath(target)}`);
	}
	process.stdout.write(`Created ${formatPath(target)}\n`);
	process.stdout.write(`Next: edit it, then run \`errkit generate\`.\n`);
}

function goPackageName(output: Output): string {
	if (output.package) return output.package;
	const parent = basename(dirname(output.path));
	if (/^[a-z_][a-z0-9_]*$/.test(parent)) return parent;
	return "errs";
}

async function writeOutput(
	configDir: string,
	output: Output,
	config: Config,
): Promise<{ status: "written" | "unchanged"; lang: "ts" | "go"; absPath: string }> {
	const lang = langFromPath(output.path);
	const { entries, warnings } = collectEntries(config, output);
	for (const w of warnings) {
		process.stderr.write(`warning: ${w}\n`);
	}
	const absPath = resolve(configDir, output.path);

	const rendered = lang === "ts"
		? renderTs(entries)
		: renderGo(entries, goPackageName(output));

	if (existsSync(absPath)) {
		const existing = await readFile(absPath, "utf8");
		if (existing === rendered) return { status: "unchanged", lang, absPath };
		if (!hasMarker(existing, markerFor(lang))) {
			fail(
				`Refusing to overwrite ${formatPath(absPath)} — file exists and is not managed by errkit`,
			);
		}
	} else {
		mkdirSync(dirname(absPath), { recursive: true });
	}

	try {
		await writeFileAtomic(absPath, rendered);
	} catch {
		fail(`Failed to write ${formatPath(absPath)}`);
	}
	return { status: "written", lang, absPath };
}

async function cmdGenerate(): Promise<void> {
	const configPath = await findConfig(process.cwd());
	if (!configPath) {
		fail(`${CONFIG_FILENAME} not found. Run \`errkit init\` first.`);
	}

	const raw = await readFile(configPath, "utf8");
	let config: Config;
	try {
		config = parseConfig(raw);
	} catch (err) {
		fail(`${formatPath(configPath)}: ${(err as Error).message}`);
	}

	const { content: updated, added } = backfillCodes(raw, config);
	if (added > 0) {
		try {
			await writeFileAtomic(configPath, updated);
		} catch {
			fail(`Failed to update ${formatPath(configPath)}`);
		}
		config = parseConfig(updated);
		process.stdout.write(`Assigned ${added} code${added === 1 ? "" : "s"} in ${formatPath(configPath)}\n`);
	}

	const outputs = config.outputs ?? [];
	if (outputs.length === 0) {
		process.stdout.write(`No outputs configured. Add entries to \`outputs\` in ${formatPath(configPath)}.\n`);
		return;
	}

	const configDir = dirname(configPath);
	for (const output of outputs) {
		const { status, lang, absPath } = await writeOutput(configDir, output, config);
		if (status === "written") {
			process.stdout.write(`Wrote ${formatPath(absPath)} (${lang})\n`);
		} else {
			process.stdout.write(`Unchanged ${formatPath(absPath)} (${lang})\n`);
		}
	}
}

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === "init") {
		if (rest.length > 0) fail(`unexpected argument: ${rest[0]}`);
		await cmdInit();
		return;
	}
	if (cmd === "generate" || cmd === "gen" || cmd === "g") {
		if (rest.length > 0) fail(`unexpected argument: ${rest[0]}`);
		await cmdGenerate();
		return;
	}
	usage();
}

await main();
