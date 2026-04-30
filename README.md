# errkit

Declare errors once in `errkit.jsonc`, generate TypeScript, Go, and Rust catalogs.

```bash
npx errkit init       # creates errkit.jsonc in the current directory
# ... edit errkit.jsonc ...
npx errkit generate   # backfills codes, writes every output file
```

## errkit.jsonc

```jsonc
{
  "$schema": "https://unpkg.com/errkit@latest/schema.json",

  "outputs": [
    { "path": "src/errors.ts", "scopes": ["server"] },
    { "path": "internal/errs/errors.go" },
    { "path": "src/errors.rs" }
  ],

  "common": {
    "USER_NOT_AUTHORIZED": { "description": "User is not authorized" }
  },

  "scopes": {
    "server": {
      "DATABASE_UNAVAILABLE": { "description": "Database is unavailable" }
    }
  }
}
```

Entries don't need a `code` — `errkit generate` fills in any missing ones and writes them back to `errkit.jsonc`.

## How it works

- Language is inferred from the file extension (`.ts`, `.go`, or `.rs`).
- Each output emits `common` entries plus any scopes it lists, flattened and sorted by name.
- A scoped entry with the same name as a common entry overrides it, with a warning.
- Codes are 6 characters from a human-safe alphabet (no `I`, `L`, `O`, `0`, `1`).
- TypeScript outputs generate PascalCase enum members.
- Go outputs generate PascalCase constants and take their package name from the parent directory (e.g. `internal/errs/errors.go` → `package errs`). Override with `"package": "..."` on the output.
- Rust outputs generate a dependency-free `Err` enum with PascalCase variants, `ALL`, `as_str`, `from_code`, `AsRef<str>`, `Display`, and `std::error::Error`.
- Existing output files are only overwritten when they start with the errkit marker comment.

## Commands

```
errkit init              Create errkit.jsonc in the current directory.
errkit generate          Read errkit.jsonc (walking up from cwd), assign any
                         missing codes, then write every file in `outputs`.
                         Aliases: `gen`, `g`.
```

## Development

```bash
bun install
bun test
bun run build
```
