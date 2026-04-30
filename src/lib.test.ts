import { test, expect, describe } from "bun:test";
import {
	isValidName,
	isValidCode,
	generateCode,
	parseConfig,
	backfillCodes,
	collectEntries,
	findMissingCodes,
	renderTs,
	renderGo,
	renderRust,
	langFromPath,
	hasMarker,
	TS_MARKER,
	GO_MARKER,
	RUST_MARKER,
	ALPHABET,
	CODE_LENGTH,
	type Entry,
} from "./lib.ts";

describe("isValidName", () => {
	test("accepts uppercase snake case", () => {
		expect(isValidName("USER_NOT_AUTHORIZED")).toBe(true);
		expect(isValidName("HTTP_404")).toBe(true);
	});

	test("rejects lowercase, camel, leading digit, hyphen, empty", () => {
		expect(isValidName("user")).toBe(false);
		expect(isValidName("UserNotAuthorized")).toBe(false);
		expect(isValidName("404_ERROR")).toBe(false);
		expect(isValidName("FOO-BAR")).toBe(false);
		expect(isValidName("")).toBe(false);
	});
});

describe("isValidCode", () => {
	test("accepts 6-char alphabet", () => {
		expect(isValidCode("ABCDEF")).toBe(true);
		expect(isValidCode("K7M2QP")).toBe(true);
	});

	test("rejects ambiguous chars and bad length", () => {
		expect(isValidCode("ABCDEO")).toBe(false); // O banned
		expect(isValidCode("ABCDE1")).toBe(false); // 1 banned
		expect(isValidCode("ABCDE")).toBe(false);
		expect(isValidCode("ABCDEFG")).toBe(false);
	});
});

describe("generateCode", () => {
	test("length and alphabet", () => {
		const code = generateCode(new Set());
		expect(code).toHaveLength(CODE_LENGTH);
		for (const ch of code) expect(ALPHABET).toContain(ch);
	});

	test("avoids collisions", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const c = generateCode(seen);
			expect(seen.has(c)).toBe(false);
			seen.add(c);
		}
	});
});

describe("langFromPath", () => {
	test("infers ts, go, and rust", () => {
		expect(langFromPath("src/errors.ts")).toBe("ts");
		expect(langFromPath("internal/errs/errors.go")).toBe("go");
		expect(langFromPath("src/errors.rs")).toBe("rs");
	});

	test("throws on unknown extension", () => {
		expect(() => langFromPath("errors.py")).toThrow();
		expect(() => langFromPath("errors")).toThrow();
	});
});

describe("parseConfig", () => {
	test("parses a populated config", () => {
		const content = `{
			"common": { "FOO": { "code": "ABCDEF", "description": "foo" } },
			"scopes": { "server": { "BAR": {} } },
			"outputs": [{ "path": "errors.ts" }, { "path": "errs.go", "scopes": ["server"] }]
		}`;
		const cfg = parseConfig(content);
		expect(cfg.common?.FOO?.code).toBe("ABCDEF");
		expect(cfg.scopes?.server?.BAR).toEqual({});
		expect(cfg.outputs).toHaveLength(2);
	});

	test("tolerates comments and trailing commas (jsonc)", () => {
		const content = `{
			// leading comment
			"common": {
				"FOO": { "description": "hi", },
			},
		}`;
		const cfg = parseConfig(content);
		expect(cfg.common?.FOO?.description).toBe("hi");
	});

	test("rejects invalid entry name", () => {
		const content = `{ "common": { "lowercase": {} } }`;
		expect(() => parseConfig(content)).toThrow(/match/);
	});

	test("rejects invalid code", () => {
		const content = `{ "common": { "FOO": { "code": "badcod" } } }`;
		expect(() => parseConfig(content)).toThrow(/code/);
	});

	test("rejects path without .ts, .go, or .rs", () => {
		const content = `{ "outputs": [{ "path": "errors.py" }] }`;
		expect(() => parseConfig(content)).toThrow(/\.ts, \.go, or \.rs/);
	});

	test("allows empty config", () => {
		expect(parseConfig(`{}`)).toEqual({});
	});
});

describe("findMissingCodes", () => {
	test("finds entries missing a code in common and scopes", () => {
		const cfg = parseConfig(`{
			"common": { "A": {}, "B": { "code": "ABCDEF" } },
			"scopes": { "s": { "C": {} } }
		}`);
		const missing = findMissingCodes(cfg);
		expect(missing.map((m) => m.path)).toEqual([
			["common", "A", "code"],
			["scopes", "s", "C", "code"],
		]);
	});
});

describe("backfillCodes", () => {
	test("injects codes only for missing entries, preserves comments", () => {
		const input = `{
  // keep me
  "common": {
    "FOO": { "description": "needs a code" },
    "BAR": { "code": "ABCDEF" }
  }
}
`;
		const cfg = parseConfig(input);
		const { content, added } = backfillCodes(input, cfg);
		expect(added).toBe(1);
		expect(content).toContain("// keep me");
		expect(content).toContain(`"code": "ABCDEF"`);
		const after = parseConfig(content);
		expect(after.common?.FOO?.code).toMatch(/^[A-Z2-9]{6}$/);
		expect(after.common?.BAR?.code).toBe("ABCDEF");
	});

	test("no-ops when everything has a code", () => {
		const input = `{ "common": { "FOO": { "code": "ABCDEF" } } }`;
		const { content, added } = backfillCodes(input, parseConfig(input));
		expect(added).toBe(0);
		expect(content).toBe(input);
	});
});

describe("collectEntries", () => {
	test("merges common with listed scopes, sorted by name", () => {
		const cfg = parseConfig(`{
			"common": { "Z_LAST": { "code": "ABCDEF", "description": "z" } },
			"scopes": {
				"server": { "A_FIRST": { "code": "GHJKMN" } },
				"client": { "NEVER": { "code": "PQRSTU" } }
			}
		}`);
		const { entries, warnings } = collectEntries(cfg, { path: "x.ts", scopes: ["server"] });
		expect(entries).toEqual([
			{ name: "A_FIRST", code: "GHJKMN" },
			{ name: "Z_LAST", code: "ABCDEF", description: "z" },
		]);
		expect(warnings).toEqual([]);
	});

	test("scope entry overrides common with same name, emits warning", () => {
		const cfg = parseConfig(`{
			"common": { "FOO": { "code": "ABCDEF", "description": "common" } },
			"scopes": { "server": { "FOO": { "code": "GHJKMN", "description": "server" } } }
		}`);
		const { entries, warnings } = collectEntries(cfg, { path: "x.ts", scopes: ["server"] });
		expect(entries).toEqual([{ name: "FOO", code: "GHJKMN", description: "server" }]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/overrides/);
	});

	test("errors on unknown scope", () => {
		const cfg = parseConfig(`{ "common": {} }`);
		expect(() => collectEntries(cfg, { path: "x.ts", scopes: ["nope"] })).toThrow(/unknown scope/);
	});

	test("errors if an entry has no code (must call generate first)", () => {
		const cfg = parseConfig(`{ "common": { "FOO": {} } }`);
		expect(() => collectEntries(cfg, { path: "x.ts" })).toThrow(/missing a code/);
	});
});

describe("renderTs", () => {
	test("renders enum with PascalCase members and JSDoc", () => {
		const entries: Entry[] = [
			{ name: "A", code: "AAAAAA" },
			{ name: "USER_NOT_AUTHORIZED", code: "BBBBBB", description: "bee" },
		];
		const out = renderTs(entries);
		expect(out).toContain(TS_MARKER);
		expect(out).toContain(`A = "AAAAAA",`);
		expect(out).toContain(`UserNotAuthorized = "BBBBBB",`);
		expect(out).not.toContain("USER_NOT_AUTHORIZED");
		expect(out).toContain("/** bee */");
		expect(hasMarker(out, TS_MARKER)).toBe(true);
	});

	test("rejects entries that generate the same TypeScript enum member", () => {
		expect(() =>
			renderTs([
				{ name: "FOO_BAR", code: "AAAAAA" },
				{ name: "FOO__BAR", code: "BBBBBB" },
			]),
		).toThrow(/both generate TypeScript enum member FooBar/);
	});
});

describe("renderGo", () => {
	test("renders const block with package name and PascalCase constants", () => {
		const entries: Entry[] = [
			{ name: "A", code: "AAAAAA" },
			{ name: "USER_NOT_AUTHORIZED", code: "BBBBBB", description: "bee" },
		];
		const out = renderGo(entries, "errs");
		expect(out).toContain(GO_MARKER);
		expect(out).toContain("package errs");
		expect(out).toContain("type Err string");
		expect(out).toContain(`A Err = "AAAAAA"`);
		expect(out).toContain(`UserNotAuthorized Err = "BBBBBB"`);
		expect(out).not.toContain("USER_NOT_AUTHORIZED");
		expect(out).toContain("// bee");
		expect(hasMarker(out, GO_MARKER)).toBe(true);
	});

	test("empty entries still produces valid file", () => {
		const out = renderGo([], "errs");
		expect(out).toContain("package errs");
		expect(out).toContain("const ()");
	});

	test("rejects entries that generate the same Go constant", () => {
		expect(() =>
			renderGo([
				{ name: "FOO_BAR", code: "AAAAAA" },
				{ name: "FOO__BAR", code: "BBBBBB" },
			], "errs"),
		).toThrow(/both generate Go constant FooBar/);
	});
});

describe("renderRust", () => {
	test("renders enum variants, docs, and conversions", () => {
		const entries: Entry[] = [
			{ name: "A", code: "AAAAAA" },
			{ name: "HTTP_404", code: "BBBBBB", description: "bee" },
		];
		const out = renderRust(entries);
		expect(out).toContain(RUST_MARKER);
		expect(out).toContain("pub enum Err {");
		expect(out).toContain("A,");
		expect(out).toContain("Http404,");
		expect(out).not.toContain("HTTP_404");
		expect(out).toContain("/// bee");
		expect(out).toContain("pub const ALL: &'static [Self]");
		expect(out).toContain("pub const fn as_str(self) -> &'static str");
		expect(out).toContain(`Self::Http404 => "BBBBBB",`);
		expect(out).toContain("pub fn from_code(code: &str) -> Option<Self>");
		expect(out).toContain("impl fmt::Display for Err");
		expect(out).toContain("impl std::error::Error for Err {}");
		expect(hasMarker(out, RUST_MARKER)).toBe(true);
	});

	test("empty entries still produces valid enum", () => {
		const out = renderRust([]);
		expect(out).toContain("pub enum Err {");
		expect(out).toContain("impl Err {");
		expect(out).toContain("pub const ALL: &'static [Self] = &[];");
		expect(out).toContain("as_str");
	});

	test("rejects entries that generate the same rust variant", () => {
		expect(() =>
			renderRust([
				{ name: "FOO_BAR", code: "AAAAAA" },
				{ name: "FOO__BAR", code: "BBBBBB" },
			]),
		).toThrow(/both generate Rust variant FooBar/);
	});

	test("rejects entries that generate reserved rust variants", () => {
		expect(() => renderRust([{ name: "SELF", code: "AAAAAA" }])).toThrow(
			/reserved Rust variant name Self/,
		);
	});
});
