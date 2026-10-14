import { describe, expect, it } from "vite-plus/test";

import { check, type Tree } from "./check.ts";

const STORE = "apps/cloud/src/user/UserStore.ts";
const TABLES = "apps/cloud/src/user/UserTables.ts";
const WRANGLER = "apps/cloud/wrangler.jsonc";

const tree = (files: Record<string, string>): Tree => ({
  files: Object.keys(files),
  read: (path) => files[path] ?? null,
});

const store = (entries: string) => `import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import * as UserTables from "./UserTables.ts";

const migrations = Migrator.fromRecord({
${entries}
});
`;

/** An inline migration running `statements`. */
const sqlEntry = (name: string, ...statements: ReadonlyArray<string>) =>
  `  "${name}": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
${statements.map((statement) => `    yield* sql\`${statement}\`;`).join("\n")}
  }),`;

const INIT = sqlEntry("0001_init", "CREATE TABLE profile (id TEXT PRIMARY KEY)");
const base = tree({ [STORE]: store(INIT) });
const withNew = (...entries: ReadonlyArray<string>) =>
  tree({ [STORE]: store([INIT, ...entries].join("\n")) });

const wrangler = (migrations: string) => `{
  // Durable Objects
  "name": "signalbox-cloud",
  "routes": [{ "pattern": "https://app.example/*" }],
  "migrations": [${migrations}],
}`;

describe("cloud migrations check", () => {
  it("passes additive migrations", () => {
    const report = check(
      base,
      withNew(
        sqlEntry(
          "0002_links",
          "CREATE TABLE links (id TEXT PRIMARY KEY)",
          "CREATE INDEX links_by_id ON links (id)",
          "INSERT INTO links (id) VALUES ('first')",
        ),
        sqlEntry(
          "0003_columns",
          "ALTER TABLE profile ADD COLUMN nickname TEXT",
          "ALTER TABLE profile ADD COLUMN visits INTEGER NOT NULL DEFAULT 0",
          "CREATE INDEX IF NOT EXISTS profile_nickname ON profile (nickname)",
        ),
      ),
    );
    expect(report).toEqual({
      violations: [],
      added: [
        { migration: `${STORE} 0002_links`, reasons: [] },
        { migration: `${STORE} 0003_columns`, reasons: [] },
      ],
      verdict: "additive",
    });
  });

  it("flags DROP and RENAME as ship-only without failing", () => {
    const report = check(
      base,
      withNew(
        sqlEntry("0002_drop", "DROP TABLE profile"),
        sqlEntry("0003_rename", "ALTER TABLE profile RENAME COLUMN id TO user_id"),
      ),
    );
    expect(report.violations).toEqual([]);
    expect(report.verdict).toBe("ship-only");
    expect(report.added.map((added) => added.reasons)).toEqual([
      ["not additive: DROP TABLE profile"],
      ["not additive: ALTER TABLE profile RENAME COLUMN id TO user_id"],
    ]);
  });

  it("flags required columns, data rewrites and code it can't read", () => {
    const report = check(
      base,
      withNew(
        sqlEntry("0002_required", "ALTER TABLE profile ADD COLUMN email TEXT NOT NULL"),
        sqlEntry("0003_backfill", "UPDATE profile SET id = lower(id)"),
        `  "0004_loop": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql\`SELECT id FROM profile\`;
    for (const row of rows) yield* sql\`DELETE FROM profile WHERE id = \${row.id}\`;
  }),`,
      ),
    );
    expect(report.added.map((added) => added.reasons.length > 0)).toEqual([true, true, true]);
    expect(report.added[2]!.reasons).toContain("code the guard can't read: rows");
  });

  it("fails when a merged migration is edited or removed", () => {
    const merged = tree({
      [STORE]: store([INIT, `  "0002_tables": UserTables.createTables,`].join("\n")),
      [TABLES]: `export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql\`CREATE TABLE links (id TEXT PRIMARY KEY)\`;
});
`,
    });
    const editedElsewhere = tree({
      [STORE]: store([INIT, `  "0002_tables": UserTables.createTables,`].join("\n")),
      [TABLES]: `export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql\`CREATE TABLE links (id TEXT PRIMARY KEY, url TEXT)\`;
});
`,
    });
    expect(check(merged, editedElsewhere).violations).toEqual([
      `${STORE} 0002_tables: edited after it merged`,
    ]);
    expect(check(merged, base).violations).toEqual([
      `${STORE} 0002_tables: removed after it merged`,
    ]);
  });

  it("fails when a const a merged migration interpolates is edited", () => {
    const named = (table: string) =>
      tree({
        [STORE]: store(
          `  "0001_init": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql\`CREATE TABLE \${sql(TABLE)} (id TEXT PRIMARY KEY)\`;
  }),`,
        ).replace("const migrations", `const TABLE = "${table}";\n\nconst migrations`),
      });
    expect(check(named("profile"), named("people")).violations).toEqual([
      `${STORE} 0001_init: edited after it merged`,
    ]);
  });

  it("treats rows written to a table that already exists as a rewrite", () => {
    const report = check(
      base,
      withNew(
        sqlEntry(
          "0002_seed",
          "CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY)",
          "INSERT INTO profile (id) VALUES ('seed')",
        ),
      ),
    );
    expect(report.added[0]!.reasons).toEqual([
      "not additive: INSERT INTO profile (id) VALUES ('seed')",
    ]);
  });

  it("ignores comments and formatting in a merged migration", () => {
    const reformatted = tree({
      [STORE]: store(
        `  // The first migration.
  "0001_init": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql\`CREATE TABLE profile (id TEXT PRIMARY KEY)\`; // the profile
  }),`,
      ),
    });
    expect(check(base, reformatted)).toEqual({ violations: [], added: [], verdict: "none" });
  });

  it("flags a new Durable Object class and fails an edited one", () => {
    const v1 = `{ "tag": "v1", "new_sqlite_classes": ["UserObject"] }`;
    const before = tree({ [STORE]: store(INIT), [WRANGLER]: wrangler(v1) });
    const added = check(
      before,
      tree({
        [STORE]: store(INIT),
        [WRANGLER]: wrangler(`${v1}, { "tag": "v2", "new_sqlite_classes": ["ThreadObject"] }`),
      }),
    );
    expect(added.violations).toEqual([]);
    expect(added.verdict).toBe("ship-only");
    expect(added.added.map((migration) => migration.migration)).toEqual([`${WRANGLER} v2`]);

    const renamed = check(
      before,
      tree({
        [STORE]: store(INIT),
        [WRANGLER]: wrangler(`{ "tag": "v1", "new_sqlite_classes": ["AccountObject"] }`),
      }),
    );
    expect(renamed.violations).toEqual([
      `${WRANGLER} migrations[0]: edited or removed after it merged`,
    ]);
  });
});
