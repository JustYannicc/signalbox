// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone CI guard, run with plain node.
/**
 * Rejects new fork-only numbered server persistence migrations:
 *
 *   node scripts/fork-migrations/check.ts --base <sha> [--head <sha>] [--upstream <ref>]
 *
 * Only root-level numbered migration modules are in scope. The base/head
 * comparison means old fork files are not a baseline exception or global debt.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const MIGRATIONS = "apps/server/src/persistence/Migrations";
const MIGRATION_FILE = /^apps\/server\/src\/persistence\/Migrations\/\d+_[^/]+\.ts$/;

export interface CheckOptions {
  readonly base: string;
  readonly head: string;
  readonly upstream: string;
}

export interface Report {
  readonly mergeBase: string;
  readonly added: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<string>;
}

function git(root: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolveCommit(root: string, ref: string, label: string): string {
  try {
    return git(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ]).trim();
  } catch {
    const repair =
      label === "upstream"
        ? "Fetch the upstream repository with `git fetch t3code main:refs/remotes/upstream/main`."
        : `Fetch the ${label} commit and pass its ref with --${label}.`;
    throw new Error(`Cannot resolve ${label} ref "${ref}" as a commit. ${repair}`);
  }
}

function migrationFiles(root: string, ref: string): Set<string> {
  const paths = git(root, ["ls-tree", "-r", "--name-only", "-z", ref, "--", MIGRATIONS]);
  return new Set(
    paths
      .split("\0")
      .filter(
        (path) =>
          MIGRATION_FILE.test(path) && !path.endsWith(".test.ts") && !path.endsWith(".d.ts"),
      ),
  );
}

export function check(root: string, options: CheckOptions): Report {
  const base = resolveCommit(root, options.base, "base");
  const head = resolveCommit(root, options.head, "head");
  const upstream = resolveCommit(root, options.upstream, "upstream");
  let mergeBase: string;
  try {
    mergeBase = git(root, ["merge-base", head, upstream]).trim();
    if (!mergeBase) throw new Error("empty merge base");
  } catch {
    throw new Error(
      `No merge base exists between candidate "${options.head}" and upstream "${options.upstream}". ` +
        "Fetch the upstream repository into refs/remotes/upstream/main and check that the candidate shares Signalbox's upstream history.",
    );
  }

  const baseFiles = migrationFiles(root, base);
  const headFiles = migrationFiles(root, head);
  const upstreamFiles = migrationFiles(root, upstream);
  const added = [...headFiles].filter((path) => !baseFiles.has(path)).sort();
  const violations = added.filter((path) => !upstreamFiles.has(path));
  return { mergeBase, added, violations };
}

function escapeAnnotationData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeAnnotationProperty(value: string): string {
  return escapeAnnotationData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function main(argv: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      upstream: { type: "string", default: "upstream/main" },
    },
  });
  if (!values.base) {
    throw new Error(
      "Usage: check.ts --base <ref> [--head <ref>] [--upstream <ref>] (fetch upstream/main first)",
    );
  }

  const root = NodePath.resolve(import.meta.dirname, "../..");
  const report = check(root, {
    base: values.base,
    head: values.head,
    upstream: values.upstream,
  });
  console.log(
    `Checked ${report.added.length} new numbered server migration(s) against ${values.upstream} ` +
      `(shared upstream base ${report.mergeBase.slice(0, 12)}).`,
  );
  for (const path of report.violations) {
    const message =
      `${path}: numbered server migrations must come from the upstream repository; ` +
      "use CREATE TABLE IF NOT EXISTS for fork-owned tables.";
    console.error(
      `::error file=${escapeAnnotationProperty(path)},title=Fork-only server migration::${escapeAnnotationData(message)}`,
    );
  }
  if (report.violations.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
