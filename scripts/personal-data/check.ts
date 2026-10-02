// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone CI guard, run with plain node.
/**
 * Fails when lines this fork adds over upstream contain personal data. Upstream
 * content never trips it: only lines added between merge-base(HEAD, upstream)
 * and HEAD are scanned, which also covers a pull request's own additions.
 *
 *   node scripts/personal-data/check.ts                      against upstream/main
 *   node scripts/personal-data/check.ts --upstream FETCH_HEAD
 *
 * Two checks:
 * - Email addresses whose domain is not in allowlist.txt (placeholders, noreply).
 * - Terms from PERSONAL_DATA_DENYLIST, one per line, case-insensitive. A term
 *   matches as a whole word; prefix it with `*` to match anywhere, e.g. inside
 *   camelCase identifiers. Blank lines and `#` comments are ignored.
 *
 * The denylist is itself personal data, so it lives in a repository secret and
 * never in this public repo. Output names the term by its index, never its text.
 * Without the variable (forks, local runs) only the email check runs.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface AddedLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export type Finding =
  | {
      readonly kind: "email";
      readonly file: string;
      readonly line: number;
      readonly domain: string;
    }
  | { readonly kind: "term"; readonly file: string; readonly line: number; readonly term: number };

interface DenyTerm {
  readonly index: number;
  readonly pattern: RegExp;
}

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/** `icon@2x.png` and friends look like addresses; real TLDs this short collide with file types. */
const FILE_EXTENSIONS = new Set(
  "png jpg jpeg gif svg webp avif ico js mjs cjs ts mts cts jsx tsx json css scss html md txt map wasm".split(
    " ",
  ),
);

/** Parses `git diff -U0` output into the lines it adds, with their new-file line numbers. */
export function parseAddedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let file: string | null = null;
  let line = 0;
  let inHeader = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
    } else if (inHeader && raw.startsWith("+++ ")) {
      // `+++ b/path`, or `+++ "b/pa\th"` when git quotes it; a trailing tab marks paths with spaces.
      const path = raw
        .slice(4)
        .replace(/\t$/, "")
        .replace(/^"(.*)"$/, "$1");
      file = path === "/dev/null" ? null : path.slice(2);
    } else if (raw.startsWith("@@")) {
      inHeader = false;
      const match = /^@@ -\S+ \+(\d+)/.exec(raw);
      line = match ? Number(match[1]) : 0;
    } else if (!inHeader && raw.startsWith("+") && file !== null) {
      added.push({ file, line, text: raw.slice(1) });
      line += 1;
    }
  }
  return added;
}

/** Allowlist entries: `example.com` (and its subdomains), `*.example` (suffix), or one exact address. */
export function isAllowedEmail(address: string, allowlist: ReadonlyArray<string>): boolean {
  const lower = address.toLowerCase();
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  return allowlist.some((entry) => {
    if (entry.includes("@")) return entry === lower;
    if (entry.startsWith("*.")) return domain.endsWith(entry.slice(1));
    return domain === entry || domain.endsWith(`.${entry}`);
  });
}

export function parseAllowlist(text: string): string[] {
  return parseListLines(text).map((entry) => entry.toLowerCase());
}

export function parseDenylist(text: string): DenyTerm[] {
  return parseListLines(text).map((entry, index) => {
    const substring = entry.startsWith("*");
    const escaped = (substring ? entry.slice(1) : entry).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const source = substring ? escaped : `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`;
    return { index: index + 1, pattern: new RegExp(source, "iu") };
  });
}

function parseListLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"));
}

export function scanLines(
  lines: ReadonlyArray<AddedLine>,
  allowlist: ReadonlyArray<string>,
  denylist: ReadonlyArray<DenyTerm>,
): Finding[] {
  const findings: Finding[] = [];
  for (const { file, line, text } of lines) {
    for (const match of text.matchAll(EMAIL)) {
      const domain = match[1]!.toLowerCase();
      if (FILE_EXTENSIONS.has(domain.slice(domain.lastIndexOf(".") + 1))) continue;
      if (isAllowedEmail(match[0], allowlist)) continue;
      findings.push({ kind: "email", file, line, domain });
    }
    for (const term of denylist) {
      if (term.pattern.test(text)) findings.push({ kind: "term", file, line, term: term.index });
    }
  }
  return findings;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
}

/** Lines HEAD adds over its merge-base with `upstream`. Throws when the merge-base is unresolvable. */
export function forkAddedLines(cwd: string, upstream: string): AddedLine[] {
  const base = git(cwd, ["merge-base", "HEAD", upstream]).trim();
  const diff = git(cwd, [
    "-c",
    "core.quotePath=false",
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "-M",
    base,
    "HEAD",
  ]);
  return parseAddedLines(diff);
}

export function formatFinding(finding: Finding): string {
  const where = `${finding.file}:${finding.line}`;
  return finding.kind === "email"
    ? `${where}: email address at non-allowlisted domain ${finding.domain}`
    : `${where}: matches denylist term #${finding.term}`;
}

function main(argv: ReadonlyArray<string>) {
  const flag = argv.indexOf("--upstream");
  const upstream = flag === -1 ? "upstream/main" : argv[flag + 1];
  if (!upstream) throw new Error("--upstream needs a ref");
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const allowlist = parseAllowlist(
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "allowlist.txt"), "utf8"),
  );
  const denylist = parseDenylist(process.env.PERSONAL_DATA_DENYLIST ?? "");
  if (denylist.length === 0) {
    console.log("PERSONAL_DATA_DENYLIST is not set: checking email addresses only.");
  } else {
    console.log(`Checking email addresses and ${denylist.length} denylist term(s).`);
  }

  const lines = forkAddedLines(root, upstream);
  const findings = scanLines(lines, allowlist, denylist);
  console.log(`Scanned ${lines.length} line(s) added over ${upstream}.`);
  for (const finding of findings) console.log(formatFinding(finding));
  if (findings.length > 0) {
    console.log(
      `${findings.length} finding(s). Replace real people, companies, and addresses with invented ones; ` +
        "add true false positives to scripts/personal-data/allowlist.txt.",
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
