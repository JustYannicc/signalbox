// @effect-diagnostics nodeBuiltinImport:off - Builds throwaway git repositories on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { check, gitTree, parseJsonc, type Tree } from "./check.ts";

const STORE = "apps/cloud/src/user/UserStore.ts";
const TABLES = "apps/cloud/src/user/UserTables.ts";
const WRANGLER = "apps/cloud/wrangler.jsonc";

it("preserves class separators and string commas while removing JSONC trailing commas", () => {
  expect(
    parseJsonc(`{
    // Two classes belong to one migration.
    "new_sqlite_classes": ["HomeObject", "CatalogScheduler",],
    "without_trailing_comma": ["HomeObject", "CatalogScheduler"],
    "literal": "keep,]",
  }`),
  ).toEqual({
    new_sqlite_classes: ["HomeObject", "CatalogScheduler"],
    without_trailing_comma: ["HomeObject", "CatalogScheduler"],
    literal: "keep,]",
  });
});

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

// CI checks a pull request on GitHub's merge of it into its base, against that
// base (the merge's first parent).
describe("cloud migrations check on a pull request's merge", () => {
  let repo: string;
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const commit = (entries: ReadonlyArray<string>, message: string) => {
    NodeFS.writeFileSync(NodePath.join(repo, STORE), store(entries.join("\n")));
    git("commit", "--quiet", "--all", "-m", message);
  };
  /** Merges `branch` into `base` the way GitHub builds `refs/pull/<n>/merge`. */
  const pullRequestMerge = (base: string, branch: string) => {
    git("checkout", "--quiet", "--detach", base);
    git("merge", "--quiet", "--no-ff", "--no-edit", branch);
    return check(gitTree(repo, "HEAD^1"), gitTree(repo, "HEAD"));
  };

  const ROLES = sqlEntry("0002_roles", "CREATE TABLE roles (id TEXT PRIMARY KEY)");
  const LINKS = sqlEntry("0003_links", "CREATE TABLE links (id TEXT PRIMARY KEY)");
  const KEYS = sqlEntry("0017_api_keys", "CREATE TABLE api_keys (id TEXT PRIMARY KEY)");

  beforeEach(() => {
    repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-migrations-"));
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    NodeFS.mkdirSync(NodePath.join(repo, NodePath.dirname(STORE)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, STORE), store([INIT, ROLES, LINKS].join("\n")));
    git("add", "--all");
    git("commit", "--quiet", "-m", "root");
    git("branch", "feature");
    // Main merges a migration after the branch forked.
    commit([INIT, ROLES, LINKS, KEYS], "api keys");
  });

  afterEach(() => {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });

  it("passes a branch that only lags main", () => {
    git("checkout", "--quiet", "feature");
    NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "unrelated\n");
    git("add", "README.md");
    git("commit", "--quiet", "-m", "unrelated");

    // The branch's head alone lacks main's migration.
    expect(check(gitTree(repo, "main"), gitTree(repo, "feature")).violations).toEqual([
      `${STORE} 0017_api_keys: removed after it merged`,
    ]);
    expect(pullRequestMerge("main", "feature")).toEqual({
      violations: [],
      added: [],
      verdict: "none",
    });
  });

  it("fails a branch that removes a merged migration", () => {
    git("checkout", "--quiet", "feature");
    commit([ROLES, LINKS], "drop init");

    expect(pullRequestMerge("main", "feature").violations).toEqual([
      `${STORE} 0001_init: removed after it merged`,
    ]);
  });
});
