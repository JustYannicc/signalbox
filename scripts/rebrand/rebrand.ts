// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone source codemod, run by hand after upstream merges.
/**
 * Renames user-facing T3 Code text to Signalbox in the source tree. Not a
 * build step: run it after merging upstream and commit the result.
 *
 *   node scripts/rebrand/rebrand.ts           rewrite files
 *   node scripts/rebrand/rebrand.ts --check   exit 1 if anything would change
 *
 * Only text users read or type is touched: string literals, template text,
 * and JSX text in JS/TS (comments and identifiers keep upstream's names, so
 * upstream patches still apply), and prose in docs. Code identifiers, env
 * vars, package names, and the t3.json format stay upstream's on purpose.
 * Idempotent: a second run changes nothing. See docs/operations/upstream-sync.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import ts from "typescript-legacy";

export const REPOSITORY = "JustYannicc/signalbox";
const RAW_SCRIPTS_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/scripts`;

interface Rule {
  readonly pattern: RegExp;
  readonly replace: string;
}

/** Product names. Safe in any text: identifiers never contain the space. */
const NAME_RULES: ReadonlyArray<Rule> = [
  { pattern: /T3 Code/g, replace: "Signalbox" },
  { pattern: /T3 Connect/g, replace: "Signalbox Connect" },
  { pattern: /T3(?:\+|%20)Code/g, replace: "Signalbox" }, // URL-encoded
  { pattern: /\bT3 data directory\b/g, replace: "Signalbox data directory" },
];

const CLI_SUBCOMMANDS = [
  "serve",
  "service",
  "connect",
  "update",
  "uninstall",
  "theme",
  "pair",
  "app",
  "triage",
  "trace",
  "auth",
  "project",
  "--help",
  "--version",
];

/** Things users type or download: the CLI, its npm package, installers, deep links. */
const COMMAND_RULES: ReadonlyArray<Rule> = [
  // Package runners name the npm package; the bin it installs is `signalbox`.
  {
    pattern:
      /\b(npx|bunx|pnpm dlx|npm (?:i|install|uninstall|remove|rm) -g) t3(?=[@\s`'".,;:)]|$)/gm,
    replace: "$1 signalbox-cli",
  },
  {
    pattern: new RegExp(`(?<![\\w@./-])t3(?= (?:${CLI_SUBCOMMANDS.join("|")})(?![\\w-]))`, "g"),
    replace: "signalbox",
  },
  { pattern: /(?<![\w@./-])t3@(?=[\d$]|latest\b|nightly\b)/g, replace: "signalbox@" },
  { pattern: /`t3`/g, replace: "`signalbox`" },

  { pattern: /\bt3code(-dev|-preview)?:\/\//g, replace: "signalbox$1://" },
  {
    pattern: /https:\/\/t3\.codes\/install\.(sh|ps1)\b/g,
    replace: `${RAW_SCRIPTS_URL}/install.$1`,
  },
  {
    pattern: /https:\/\/github\.com\/pingdotgg\/t3code\/releases\b/g,
    replace: `https://github.com/${REPOSITORY}/releases`,
  },
];

/** The CLI named in prose ("Download a newer t3 and ..."): a bare word beside a lowercase word. */
const PROSE_CLI_RULE: Rule = {
  pattern: /(?<![\w@./:#$\\-])t3(?= (?:[a-z]|\$\{))|(?<=[a-z] )t3(?![\w@./:#$\\-])/g,
  replace: "signalbox",
};

/**
 * The product's short name in prose ("Open T3 to connect", "a T3 thread"). Not
 * "T3 Tools" (the company), "T3 Chat" (another product), or the "T3 home" term.
 */
const SHORT_NAME_RULE: Rule = {
  pattern:
    /(?<![\w@./:#$\\-])T3(?= [a-z])(?! home\b)|(?<=[A-Za-z,] )T3(?![\w@./:#$\\-]| (?:Tools|Code|Connect|Chat|home)\b)/g,
  replace: "Signalbox",
};

/** What users call the data home. Maintainer docs keep the glossary term "T3 home". */
const HOME_RULE: Rule = { pattern: /\bT3 home\b/g, replace: "Signalbox home" };

const ALL_RULES = [...NAME_RULES, ...COMMAND_RULES, PROSE_CLI_RULE, HOME_RULE, SHORT_NAME_RULE];
/**
 * Docs also name the data home users browse to. Code builds these paths from
 * parts (and tests assert them), so the identity change lives there instead.
 */
const DOC_RULES = [
  ...NAME_RULES,
  ...COMMAND_RULES,
  PROSE_CLI_RULE,
  SHORT_NAME_RULE,
  { pattern: /(~|\$HOME)\/\.t3\b/g, replace: "$1/.signalbox" },
];
const USER_DOC_RULES = [...DOC_RULES, HOME_RULE];
/** Table-driven test case names say "t3" for other things (env var families, fixtures). */
const TEST_CASE_NAME_RULES = [...NAME_RULES, ...COMMAND_RULES, HOME_RULE, SHORT_NAME_RULE];

/**
 * External contracts: string-valued properties that name T3 Code to a service
 * we don't control. Codex derives its client identity from `clientInfo`, and
 * OpenAI's ChatGPT consent flow registers the agent by `agent_name_hint`.
 */
export const EXTERNAL_CONTRACT_PROPERTIES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "apps/server/src/provider/Layers/CodexProvider.ts": ["name", "title"],
  "apps/server/src/provider/CodexChatGptAuth.ts": ["agent_name_hint"],
  // The t3.json format is shared with upstream; its schema keeps its name.
  "packages/contracts/src/t3ProjectFile.ts": ["title"],
};

/**
 * Test lines that keep T3 text as data: assertions on the contracts above, and
 * fixtures that use the name as a value (a project titled "T3 Code").
 */
export const PRESERVED_TEST_LINES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "apps/server/src/provider/CodexChatGptAuth.test.ts": ['get("agent_name_hint")'],
  "apps/mobile/src/features/threads/new-task-project-selection.test.ts": ['title: "T3 Code"'],
};

/** Paths the codemod never touches. */
const EXCLUDED = [
  /^\.repos\//,
  /^\.github\/(?!ISSUE_TEMPLATE\/)/, // upstream workflows and policies; issue forms are ours
  /^\.agents\//, // agent skills, maintained by hand like AGENTS.md
  /^infra\//, // T3 Connect relay: an upstream-operated service
  /^apps\/marketing\//, // upstream's t3.codes site
  /^packaging\//, // upstream's AUR packages
  /^patches\//,
  /^scripts\/rebrand\//,
  /^docs\/operations\/upstream-sync\.md$/, // names the old identifiers on purpose
  /(^|\/)UPSTREAM\.md$/,
  /^(README|AGENTS|CLAUDE|CONTRIBUTING)\.md$/, // fork-owned or upstream policy
  /^LICENSE/,
  /^pnpm-lock\.yaml$/,
];

const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/;
const DOC_FILE = /\.mdx?$|^\.github\/ISSUE_TEMPLATE\/.*\.ya?ml$/;
const NAME_ONLY_FILE = /\.(?:html|json|sh|ps1|rs|c|h|kt|swift)$|(^|\/)\.env\.example$/;

const applyRules = (text: string, rules: ReadonlyArray<Rule>) =>
  rules.reduce((value, rule) => value.replace(rule.pattern, rule.replace), text);

/** A Markdown link to the upstream repository credits T3 Code by name; keep it. */
const UPSTREAM_CREDIT = /\[T3 Code\]\(https:\/\/github\.com\/pingdotgg\/t3code[^)]*\)/g;

function applyDocRules(text: string, rules: ReadonlyArray<Rule>): string {
  const parts = text.split(UPSTREAM_CREDIT);
  const credits = text.match(UPSTREAM_CREDIT) ?? [];
  return parts.map((part, index) => applyRules(part, rules) + (credits[index] ?? "")).join("");
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const TEXT_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);

function isExternalContract(node: ts.Node, properties: ReadonlyArray<string>): boolean {
  const parent = node.parent;
  return (
    properties.length > 0 &&
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) &&
    properties.includes(parent.name.text)
  );
}

function isPropertyValue(node: ts.Node, name: string): boolean {
  const parent = node.parent;
  return (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === name
  );
}

const TEST_CALLEE = /^(?:it|test|describe)(?:\.\w+)*$/;

/** Test titles are never shown to users; leaving them alone keeps test diffs small. */
export function isTestTitle(node: ts.Node, source: ts.SourceFile): boolean {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== node) return false;
  const callee = ts.isCallExpression(call.expression)
    ? call.expression.expression
    : call.expression;
  return TEST_CALLEE.test(callee.getText(source));
}

/** Rewrites text tokens in JS/TS source. Returns the input when nothing matches. */
export function rebrandScript(file: string, code: string): string {
  if (!ALL_RULES.some((rule) => new RegExp(rule.pattern.source, "m").test(code))) return code;
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKind(file));
  const properties = EXTERNAL_CONTRACT_PROPERTIES[file] ?? [];
  const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
  const contractLines = PRESERVED_TEST_LINES[file] ?? [];
  const onContractLine = (node: ts.Node) => {
    if (contractLines.length === 0) return false;
    const start = node.getStart(source);
    const lineStart = code.lastIndexOf("\n", start) + 1;
    const lineEnd = code.indexOf("\n", start);
    const line = code.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    return contractLines.some((marker) => line.includes(marker));
  };
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isTemplateExpression(node) && isTestTitle(node, source)) return;
    if (
      TEXT_KINDS.has(node.kind) &&
      !isExternalContract(node, properties) &&
      !onContractLine(node) &&
      !isTestTitle(node, source)
    ) {
      const start = node.getStart(source);
      const raw = code.slice(start, node.end);
      const next = applyRules(
        raw,
        testFile && isPropertyValue(node, "name") ? TEST_CASE_NAME_RULES : ALL_RULES,
      );
      if (next !== raw) edits.push({ start, end: node.end, text: next });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edits
    .toSorted((a, b) => b.start - a.start)
    .reduce((value, edit) => value.slice(0, edit.start) + edit.text + value.slice(edit.end), code);
}

/** Rewrites one repository-relative file's contents, or returns them unchanged. */
export function rebrandFile(file: string, contents: string): string {
  if (EXCLUDED.some((pattern) => pattern.test(file))) return contents;
  if (SCRIPT_FILE.test(file)) return rebrandScript(file, contents);
  if (DOC_FILE.test(file)) {
    return applyDocRules(contents, file.startsWith("docs/user/") ? USER_DOC_RULES : DOC_RULES);
  }
  if (NAME_ONLY_FILE.test(file)) return applyRules(contents, NAME_RULES);
  return contents;
}

function main(argv: ReadonlyArray<string>) {
  const check = argv.includes("--check");
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const files = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", ".", ":!.repos"], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const changed: string[] = [];
  for (const file of files) {
    const absolute = NodePath.join(root, file);
    if (!NodeFS.existsSync(absolute) || NodeFS.statSync(absolute).isDirectory()) continue;
    const contents = NodeFS.readFileSync(absolute, "utf8");
    if (contents.includes("\0")) continue;
    const next = rebrandFile(file, contents);
    if (next === contents) continue;
    changed.push(file);
    if (!check) NodeFS.writeFileSync(absolute, next);
  }
  for (const file of changed) console.log(`${check ? "would rebrand" : "rebranded"} ${file}`);
  console.log(`${changed.length} file(s) ${check ? "need rebranding" : "rebranded"}.`);
  if (check && changed.length > 0) process.exitCode = 1;
}

if (import.meta.main) main(process.argv.slice(2));
