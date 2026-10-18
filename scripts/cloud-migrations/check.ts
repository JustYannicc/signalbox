// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone CI guard, run with plain node.
/**
 * Guards Signalbox Cloud's Durable Object migrations in a pull request:
 *
 *   node scripts/cloud-migrations/check.ts --base <sha> [--head <sha>]
 *
 * - Fails when a migration the base already has is edited or removed: objects
 *   that ran it never run it again. The same holds for existing `migrations`
 *   entries in apps/cloud/wrangler*.jsonc.
 * - Reports whether the new migrations are additive, so the previous version
 *   still runs on the migrated schema and the PR can be tried and rolled back,
 *   or ship-only. Ship-only never fails; it is written to the step summary and
 *   to `verdict` in GITHUB_OUTPUT (`none`, `additive` or `ship-only`).
 *
 * It reads source text. A store is a file under apps/cloud/src that calls
 * `Migrator.fromRecord({...})`; a migration's code is its entry plus every
 * const it reaches through relative imports or its own file. Anything the
 * guard can't read is ship-only.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export interface Tree {
  readonly files: ReadonlyArray<string>;
  readonly read: (path: string) => string | null;
}

export interface Added {
  readonly migration: string;
  /** Why it is ship-only; empty when additive. */
  readonly reasons: ReadonlyArray<string>;
}

export interface Report {
  readonly violations: ReadonlyArray<string>;
  readonly added: ReadonlyArray<Added>;
  readonly verdict: "none" | "additive" | "ship-only";
}

interface Source {
  /** The text with comments blanked out. */
  readonly code: string;
  /** Also with string, template and regex literals blanked out, except code in `${}`. */
  readonly bare: string;
  readonly templates: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

/** What a `/` that starts a regex, rather than divides, can follow. */
const REGEX_PREFIX =
  /(?:[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|yield|case|typeof|in|of|throw|void|delete))$|^$/;

const blank = (text: string) => text.replace(/[^\n]/g, " ");

function parse(text: string): Source {
  let code = "";
  let bare = "";
  // The last code characters, comments left out, to tell a regex from a division.
  let tail = "";
  const templates: Array<{ start: number; end: number }> = [];
  let i = 0;
  const take = (end: number, kind: "code" | "comment" | "literal" | "template") => {
    const raw = text.slice(i, end);
    code += kind === "comment" ? blank(raw) : raw;
    bare += kind === "code" ? raw : kind === "template" ? templateBare(raw) : blank(raw);
    if (kind !== "comment") tail = (tail + raw).replace(/\s+/g, " ").slice(-12);
    i = end;
  };
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      take(end === -1 ? text.length : end, "comment");
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      take(end === -1 ? text.length : end + 2, "comment");
    } else if (c === '"' || c === "'") {
      take(stringEnd(text, i), "literal");
    } else if (c === "`") {
      const end = templateEnd(text, i);
      templates.push({ start: i, end });
      take(end, "template");
    } else if (c === "/" && REGEX_PREFIX.test(tail.trimEnd())) {
      take(regexEnd(text, i), "literal");
    } else {
      take(i + 1, "code");
    }
  }
  return { code, bare, templates };
}

/** A template literal blanked, except the code in its interpolations. */
function templateBare(raw: string) {
  let out = "";
  let j = 0;
  while (j < raw.length) {
    if (raw[j] === "\\") {
      out += blank(raw.slice(j, j + 2));
      j += 2;
    } else if (raw[j] === "$" && raw[j + 1] === "{") {
      const end = interpolationEnd(raw, j + 2);
      out += `  ${raw.slice(j + 2, end - 1)} `;
      j = end;
    } else {
      out += blank(raw[j]!);
      j += 1;
    }
  }
  return out;
}

function stringEnd(text: string, start: number) {
  let j = start + 1;
  while (j < text.length && text[j] !== text[start] && text[j] !== "\n")
    j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

function regexEnd(text: string, start: number) {
  let j = start + 1;
  let inClass = false;
  while (j < text.length && text[j] !== "\n") {
    if (text[j] === "\\") j += 1;
    else if (text[j] === "[") inClass = true;
    else if (text[j] === "]") inClass = false;
    else if (text[j] === "/" && !inClass) break;
    j += 1;
  }
  j += 1;
  while (/[a-z]/.test(text[j] ?? "")) j += 1;
  return j;
}

function templateEnd(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length && text[j] !== "`") {
    if (text[j] === "\\") j += 2;
    else if (text[j] === "$" && text[j + 1] === "{") j = interpolationEnd(text, j + 2);
    else j += 1;
  }
  return j + 1;
}

/** The index after the `}` closing an interpolation whose code starts at `start`. */
function interpolationEnd(text: string, start: number) {
  let depth = 1;
  let j = start;
  while (j < text.length) {
    const c = text[j]!;
    if (c === '"' || c === "'") j = stringEnd(text, j);
    else if (c === "`") j = templateEnd(text, j);
    else {
      if (c === "{") depth += 1;
      if (c === "}" && --depth === 0) return j + 1;
      j += 1;
    }
  }
  return j;
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** Where the expression starting at `start` ends: a top-level `stops` character or an unmatched closer. */
function expressionEnd(bare: string, start: number, stops: string) {
  let depth = 0;
  for (let j = start; j < bare.length; j++) {
    const c = bare[j]!;
    if (OPEN.has(c)) depth += 1;
    else if (CLOSE.has(c)) {
      if (depth === 0) return j;
      depth -= 1;
    } else if (depth === 0 && stops.includes(c)) return j;
  }
  return bare.length;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

interface Module {
  readonly path: string;
  readonly text: string;
  readonly source: Source;
  /** Local name to the module and export it names; `*` for a namespace. */
  readonly imports: ReadonlyMap<string, { readonly path: string; readonly name: string }>;
}

function loadModule(tree: Tree, path: string): Module | null {
  const text = tree.read(path);
  if (text === null) return null;
  const source = parse(text);
  const imports = new Map<string, { path: string; name: string }>();
  const pattern = /import\s+(type\s+)?(\*\s+as\s+(\w+)|\{([^}]*)\})\s+from\s+["']([^"']+)["']/g;
  for (const match of source.code.matchAll(pattern)) {
    const [, typeOnly, , namespace, named, from] = match;
    if (typeOnly || !from!.startsWith(".")) continue;
    const target = NodePath.posix.normalize(
      NodePath.posix.join(NodePath.posix.dirname(path), from!),
    );
    if (namespace) imports.set(namespace, { path: target, name: "*" });
    for (const part of (named ?? "").split(",")) {
      const specifier = part.trim();
      if (specifier === "" || specifier.startsWith("type ")) continue;
      const [name, alias] = specifier.split(/\s+as\s+/);
      imports.set(alias ?? name!, { path: target, name: name! });
    }
  }
  return { path, text, source, imports };
}

/** The value of a top-level `const name = ...;` in `module`, as a range. */
function constRange(module: Module, name: string) {
  const escaped = name.replace(/\$/g, "\\$");
  const declaration = new RegExp(`(?:^|\\n)(?:export\\s+)?const\\s+${escaped}(?![\\w$])[^=]*=`);
  const match = declaration.exec(module.source.bare);
  if (match === null) return null;
  const start = match.index + match[0].length;
  return { start, end: expressionEnd(module.source.bare, start, ";") };
}

interface Body {
  /** Comment-free text of the entry and each const it reaches, for comparing. */
  readonly parts: ReadonlyArray<string>;
  readonly sql: ReadonlyArray<string>;
  /** Identifiers in code the guard did not follow. */
  readonly unknown: ReadonlyArray<string>;
}

/** Identifiers a migration may use without the guard following them. */
const KNOWN = new Set(
  "Effect gen function const yield sql SqlClient andThen all asVoid void discard true".split(" "),
);

/** Reads modules and their consts once per tree. */
function makeReader(tree: Tree) {
  const modules = new Map<string, Module | null>();
  const ranges = new Map<string, { start: number; end: number } | null>();
  const module = (path: string) => {
    if (!modules.has(path)) modules.set(path, loadModule(tree, path));
    return modules.get(path)!;
  };
  const range = (path: string, name: string) => {
    const key = `${path}#${name}`;
    if (!ranges.has(key)) {
      const target = module(path);
      ranges.set(key, target && constRange(target, name));
    }
    return ranges.get(key)!;
  };
  return { module, range };
}

type Reader = ReturnType<typeof makeReader>;

function readBody(reader: Reader, module: Module, start: number, end: number): Body {
  const parts: string[] = [];
  const sql: string[] = [];
  const unknown = new Set<string>();
  const seen = new Set<string>();

  const visit = (current: Module, from: number, to: number) => {
    parts.push(squash(current.source.code.slice(from, to)));
    for (const template of current.source.templates) {
      if (template.start < from || template.end > to) continue;
      const before = current.source.code.slice(Math.max(from, template.start - 8), template.start);
      if (!/\bsql\s*$/.test(before)) continue;
      sql.push(current.text.slice(template.start + 1, template.end - 1));
    }
    const code = current.source.bare.slice(from, to);
    for (const match of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
      const [, head, member] = match;
      const imported = current.imports.get(head!);
      const target =
        imported === undefined
          ? { path: current.path, name: head! }
          : imported.name !== "*"
            ? imported
            : member === undefined
              ? null
              : { path: imported.path, name: member };
      const range = target && reader.range(target.path, target.name);
      if (!target || !range) {
        if (!KNOWN.has(head!) || (member !== undefined && !KNOWN.has(member)))
          unknown.add(member === undefined ? head! : `${head}.${member}`);
        continue;
      }
      const key = `${target.path}#${target.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      visit(reader.module(target.path)!, range.start, range.end);
    }
  };
  visit(module, start, end);
  return { parts, sql, unknown: [...unknown] };
}

function migrationsOf(reader: Reader, path: string): Map<string, Body> {
  const migrations = new Map<string, Body>();
  const module = reader.module(path);
  if (module === null) return migrations;
  const { bare, code } = module.source;
  for (const call of bare.matchAll(/Migrator\.fromRecord\(\s*\{/g)) {
    const close = expressionEnd(bare, call.index + call[0].length, "");
    let j = call.index + call[0].length;
    while (!/^[\s,]*$/.test(code.slice(j, close))) {
      const key = /^[\s,]*(["'])(\d+_[^"']+)\1\s*:/.exec(code.slice(j, close));
      // Skipping it would hide every migration after it.
      if (key === null)
        throw new Error(
          `${path}: can't read the migration record at "${squash(code.slice(j, j + 60))}"`,
        );
      const start = j + key[0].length;
      const end = expressionEnd(bare, start, ",");
      migrations.set(key[2]!, readBody(reader, module, start, end));
      j = end;
    }
  }
  return migrations;
}

/** Each store's migrations by name. */
function storesOf(tree: Tree) {
  const reader = makeReader(tree);
  const stores = new Map<string, Map<string, Body>>();
  for (const file of tree.files) {
    if (!file.startsWith("apps/cloud/src/") || !file.endsWith(".ts") || file.endsWith(".test.ts"))
      continue;
    if (!tree.read(file)?.includes("Migrator.fromRecord(")) continue;
    stores.set(file, migrationsOf(reader, file));
  }
  return stores;
}

const idOf = (name: string) => Number(name.slice(0, name.indexOf("_")));

const IDENT = String.raw`(?:"([^"]+)"|\x60([^\x60]+)\x60|\[([^\]]+)\]|([\w$]+))`;
const nameOf = (match: RegExpExecArray, at: number) =>
  (match[at] ?? match[at + 1] ?? match[at + 2] ?? match[at + 3])!.toLowerCase();

const CREATE_TABLE = new RegExp(String.raw`^CREATE TABLE (IF NOT EXISTS )?${IDENT}`, "i");
const CREATE_INDEX = new RegExp(
  String.raw`^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?${IDENT} ON ${IDENT}`,
  "i",
);
const ADD_COLUMN = new RegExp(String.raw`^ALTER TABLE ${IDENT} ADD (?:COLUMN )?(.*)$`, "i");
const INSERT = new RegExp(String.raw`^INSERT (?:OR \w+ )?INTO ${IDENT}`, "i");

function statementsOf(sql: string) {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map(squash)
    .filter((statement) => statement.length > 0);
}

/** Tables and indexes a set of migrations creates. */
function createdNames(bodies: Iterable<Body>) {
  const names = new Set<string>();
  for (const body of bodies)
    for (const sql of body.sql)
      for (const statement of statementsOf(sql)) {
        const table = CREATE_TABLE.exec(statement);
        if (table) names.add(nameOf(table, 2));
        const index = CREATE_INDEX.exec(statement);
        if (index) names.add(nameOf(index, 3));
      }
  return names;
}

/** Why `statement` is ship-only, or null when additive. */
function shipOnlyReason(statement: string, existing: Set<string>, created: Set<string>) {
  const table = CREATE_TABLE.exec(statement);
  if (table) {
    const name = nameOf(table, 2);
    if (/\bAS\s+SELECT\b/i.test(statement)) return `copies data: ${statement}`;
    if (existing.has(name)) return table[1] ? null : `creates a table that exists: ${name}`;
    created.add(name);
    return null;
  }
  const index = CREATE_INDEX.exec(statement);
  if (index) {
    const name = nameOf(index, 3);
    const on = nameOf(index, 7);
    if (index[1] && !created.has(on)) return `adds a unique index to an existing table: ${name}`;
    if (existing.has(name)) return index[2] ? null : `creates an index that exists: ${name}`;
    created.add(name);
    return null;
  }
  const column = ADD_COLUMN.exec(statement);
  if (column) {
    const definition = column[5]!;
    if (/\bNOT NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition))
      return `adds a required column without a default: ${statement}`;
    if (/\b(PRIMARY KEY|UNIQUE|GENERATED|AS\s*\()/i.test(definition))
      return `adds a constrained column: ${statement}`;
    return null;
  }
  const insert = INSERT.exec(statement);
  if (insert && created.has(nameOf(insert, 1))) return null;
  return `not additive: ${statement.length > 120 ? `${statement.slice(0, 117)}...` : statement}`;
}

/** JSON with comments and trailing commas, as wrangler reads it. */
export function parseJsonc(text: string): unknown {
  const { code, bare } = parse(text);
  let json = code;
  // Keep following string values visible, and use `bare` to exclude literal commas.
  for (const comma of code.matchAll(/,(?=\s*[}\]])/g))
    if (bare[comma.index] === ",")
      json = `${json.slice(0, comma.index)} ${json.slice(comma.index + 1)}`;
  return JSON.parse(json);
}

function durableObjectMigrations(tree: Tree) {
  const scopes = new Map<string, ReadonlyArray<unknown>>();
  for (const file of tree.files) {
    if (!/^apps\/cloud\/wrangler[^/]*\.jsonc$/.test(file)) continue;
    const config = parseJsonc(tree.read(file) ?? "{}") as {
      migrations?: ReadonlyArray<unknown>;
      env?: Record<string, { migrations?: ReadonlyArray<unknown> }>;
    };
    scopes.set(file, config.migrations ?? []);
    for (const [env, settings] of Object.entries(config.env ?? {}))
      if (settings.migrations) scopes.set(`${file} env.${env}`, settings.migrations);
  }
  return scopes;
}

export function check(base: Tree, head: Tree): Report {
  const violations: string[] = [];
  const added: Added[] = [];
  const before = storesOf(base);
  const after = storesOf(head);

  for (const [store, migrations] of before)
    for (const [name, body] of migrations) {
      const now = after.get(store)?.get(name);
      if (now === undefined) violations.push(`${store} ${name}: removed after it merged`);
      else if (now.parts.join("\n") !== body.parts.join("\n"))
        violations.push(`${store} ${name}: edited after it merged`);
    }

  for (const [store, migrations] of after) {
    const merged = before.get(store) ?? new Map<string, Body>();
    const existing = createdNames(merged.values());
    const created = new Set<string>();
    // In the order the runner applies them.
    const fresh = [...migrations]
      .filter(([name]) => !merged.has(name))
      .toSorted(([a], [b]) => idOf(a) - idOf(b) || (a < b ? -1 : 1));
    for (const [name, body] of fresh) {
      const reasons = body.unknown.map((identifier) => `code the guard can't read: ${identifier}`);
      if (body.sql.some((sql) => sql.includes("${")))
        reasons.push("builds SQL at runtime, which the guard can't read");
      for (const sql of body.sql)
        for (const statement of statementsOf(sql)) {
          const reason = shipOnlyReason(statement, existing, created);
          if (reason) reasons.push(reason);
        }
      added.push({ migration: `${store} ${name}`, reasons });
    }
  }

  const objectsBefore = durableObjectMigrations(base);
  const objectsAfter = durableObjectMigrations(head);
  for (const [scope, entries] of objectsBefore) {
    const now = objectsAfter.get(scope) ?? [];
    entries.forEach((entry, index) => {
      if (JSON.stringify(now[index]) !== JSON.stringify(entry))
        violations.push(`${scope} migrations[${index}]: edited or removed after it merged`);
    });
  }
  for (const [scope, entries] of objectsAfter)
    for (const entry of entries.slice(objectsBefore.get(scope)?.length ?? 0))
      added.push({
        migration: `${scope} ${(entry as { tag?: string }).tag ?? "migration"}`,
        reasons: [`changes Durable Object classes: ${JSON.stringify(entry)}`],
      });

  const verdict =
    added.length === 0
      ? "none"
      : added.every((migration) => migration.reasons.length === 0)
        ? "additive"
        : "ship-only";
  return { violations, added, verdict };
}

export function format(report: Report) {
  const lines = [`### Cloud migrations: ${report.verdict}`, ""];
  for (const violation of report.violations) lines.push(`- ❌ ${violation}`);
  for (const migration of report.added) {
    lines.push(
      `- ${migration.reasons.length === 0 ? "additive" : "ship-only"}: ${migration.migration}`,
    );
    for (const reason of migration.reasons) lines.push(`  - ${reason}`);
  }
  if (report.verdict === "ship-only")
    lines.push("", "Ship-only: the previous version may not run on the migrated schema.");
  return lines.join("\n");
}

export function gitTree(root: string, rev: string): Tree {
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const known = new Set(
    git("ls-tree", "-r", "--name-only", rev, "--", "apps/cloud").split("\n").filter(Boolean),
  );
  // Only stores and wrangler configs are listed; imports read any file in `known`.
  let stores: string[] = [];
  try {
    stores = git("grep", "-l", "-F", "Migrator.fromRecord(", rev, "--", "apps/cloud/src")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(rev.length + 1));
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if ((error as { readonly status?: number }).status !== 1) throw error;
  }
  const files = [
    ...stores,
    ...[...known].filter((file) => /^apps\/cloud\/wrangler[^/]*\.jsonc$/.test(file)),
  ];
  const cache = new Map<string, string | null>();
  return {
    files,
    read: (path) => {
      if (!known.has(path)) return null;
      if (!cache.has(path)) cache.set(path, git("show", `${rev}:${path}`));
      return cache.get(path)!;
    },
  };
}

function main(argv: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: { base: { type: "string" }, head: { type: "string", default: "HEAD" } },
  });
  if (values.base === undefined) throw new Error("Usage: check.ts --base <rev> [--head <rev>]");
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const report = check(gitTree(root, values.base), gitTree(root, values.head));
  const summary = format(report);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (process.env.GITHUB_OUTPUT)
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${report.verdict}\n`);
  if (report.verdict === "ship-only")
    console.log(
      "::notice title=Cloud migrations::Ship-only: this PR can't be tried and rolled back.",
    );
  for (const violation of report.violations)
    console.log(`::error title=Cloud migrations::${violation}`);
  if (report.violations.length > 0) process.exit(1);
}

if (import.meta.main) main(process.argv.slice(2));
