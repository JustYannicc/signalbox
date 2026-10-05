// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone CI script, run by upstream-sync.yml.
/**
 * Merges upstream T3 Code into Signalbox. Run by .github/workflows/upstream-sync.yml
 * in a checkout of `origin/main` with `upstream/main` fetched and `gh` authenticated.
 *
 *   node scripts/upstream-sync/sync.ts
 *   node scripts/upstream-sync/sync.ts --post-merge   only the post-merge steps, for a hand merge
 *
 * - Nothing new upstream: closes a stale conflict issue, then stops.
 * - Clean merge: rebuilds the `upstream-sync` branch from main (merge, never
 *   rebase), applies the post-merge steps from docs/operations/upstream-sync.md,
 *   and opens or updates one PR with auto-merge (merge commit) enabled.
 * - Conflict, or a push GitHub refuses: opens or updates one issue labelled
 *   `upstream-sync-conflict`. A later clean sync closes it.
 *
 * Set DISPATCH_CI=true when pushing with GITHUB_TOKEN: its pushes and PRs don't
 * start CI runs, but a workflow_dispatch does, and that run's checks land on
 * the branch head the PR shows.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { conflictingFiles, git, isAncestor } from "./mergeTree.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "../..");
const BASE = "origin/main";
const UPSTREAM = "upstream/main";
const BRANCH = "upstream-sync";
const LABEL = "upstream-sync-conflict";
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const REPOSITORY = process.env.GITHUB_REPOSITORY ?? "JustYannicc/signalbox";
const RUNBOOK_URL = `https://github.com/${REPOSITORY}/blob/main/docs/operations/upstream-sync.md`;

// gh infers its repo from git remotes and can pick `upstream`, so every issue,
// label, and PR call would land on T3 Code. Pin it for all child processes.
process.env.GH_REPO = REPOSITORY;

function run(command: string, args: ReadonlyArray<string>): string {
  console.log(`$ ${command} ${args.join(" ")}`);
  const output = NodeChildProcess.execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).trimEnd();
  if (output) console.log(output);
  return output;
}

function runLink(): string {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return "a local run";
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function upstreamCommitLink(sha: string): string {
  return `[\`${sha.slice(0, 12)}\`](https://github.com/${UPSTREAM_REPOSITORY}/commit/${sha})`;
}

function openConflictIssue(): string | undefined {
  const number = run("gh", [
    "issue",
    "list",
    "--label",
    LABEL,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]);
  return number || undefined;
}

function reportBlocked(summary: string, details: string, upstreamSha: string) {
  const body = [
    `The scheduled upstream sync can't land ${UPSTREAM_REPOSITORY} main at ${upstreamCommitLink(upstreamSha)}: ${summary}`,
    "",
    details,
    "",
    `Merge it by hand on a branch off \`main\` following [the runbook](${RUNBOOK_URL}), open a PR, and merge it with a merge commit. The next sync closes this issue once \`main\` merges cleanly.`,
    "",
    `Last checked by ${runLink()}.`,
  ].join("\n");
  run("gh", [
    "label",
    "create",
    LABEL,
    "--force",
    "--color",
    "B60205",
    "--description",
    "The scheduled upstream merge needs a hand",
  ]);
  const existing = openConflictIssue();
  if (existing) {
    run("gh", ["issue", "edit", existing, "--body", body]);
  } else {
    run("gh", [
      "issue",
      "create",
      "--title",
      "Upstream sync needs a hand",
      "--label",
      LABEL,
      "--body",
      body,
    ]);
  }
}

function closeConflictIssue(reason: string) {
  const existing = openConflictIssue();
  if (existing) run("gh", ["issue", "close", existing, "--comment", `${reason} (${runLink()}).`]);
}

/** Post-merge steps from the runbook: rename, format, regenerate. */
async function applyPostMergeSteps() {
  run("vp", ["install", "--no-frozen-lockfile"]);
  run("node", ["scripts/rebrand/rebrand.ts"]);
  run("vp", ["fmt"]);

  const triagePrompt = await import(
    NodeURL.pathToFileURL(NodePath.join(ROOT, "apps/server/src/cli/triagePrompt.ts")).href
  );
  NodeFS.writeFileSync(
    NodePath.join(ROOT, ".github/triage/PLAYBOOK.md"),
    triagePrompt.TRIAGE_PLAYBOOK,
  );

  await generateRouteTree();
}

/**
 * Regenerates apps/web/src/routeTree.gen.ts the way the web app's Vite plugin
 * does, without starting Vite. The generator ships inside @tanstack/router-plugin.
 */
async function generateRouteTree() {
  const webRoot = NodePath.join(ROOT, "apps/web");
  const fromWeb = NodeModule.createRequire(NodePath.join(webRoot, "package.json"));
  const fromPlugin = NodeModule.createRequire(
    fromWeb.resolve("@tanstack/router-plugin/package.json"),
  );
  const generator = await import(
    NodeURL.pathToFileURL(fromPlugin.resolve("@tanstack/router-generator")).href
  );
  // Same options as tanstackRouter() in apps/web/vite.config.ts.
  const config = generator.getConfig({ autoCodeSplitting: true }, webRoot);
  await new generator.Generator({ config, root: webRoot }).run();
}

function ensurePullRequest(upstreamSha: string): string {
  const count = git(ROOT, ["rev-list", "--count", `${BASE}..${UPSTREAM}`]);
  const body = [
    `Merges ${UPSTREAM_REPOSITORY} main at ${upstreamCommitLink(upstreamSha)} (${count} new commits), then reruns the rebrand codemod, \`vp fmt\`, and the generated files.`,
    "",
    `Auto-merge lands this with a merge commit once Check passes. Never squash or rebase it: that drops upstream's history and turns every later sync into conflicts. Upstream may add identity values the codemod can't rename; see [the runbook](${RUNBOOK_URL}).`,
    "",
    `Last updated by ${runLink()}.`,
  ].join("\n");
  const existing = run("gh", [
    "pr",
    "list",
    "--head",
    BRANCH,
    "--base",
    "main",
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]);
  if (existing) {
    run("gh", ["pr", "edit", existing, "--body", body]);
    return existing;
  }
  const url = run("gh", [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    BRANCH,
    "--title",
    "chore: sync upstream T3 Code",
    "--body",
    body,
  ]);
  return url.split("/").at(-1) ?? url;
}

function enableAutoMerge(pr: string) {
  try {
    run("gh", ["pr", "merge", pr, "--auto", "--merge"]);
  } catch {
    console.log(
      `::warning::Could not enable auto-merge on #${pr}. Allow auto-merge and merge commits in the repository settings.`,
    );
  }
}

function remoteBranchHead(): string | undefined {
  const line = git(ROOT, ["ls-remote", "origin", `refs/heads/${BRANCH}`]);
  return line.split(/\s+/)[0] || undefined;
}

async function main() {
  const upstreamSha = git(ROOT, ["rev-parse", UPSTREAM]);
  if (isAncestor(ROOT, UPSTREAM, BASE)) {
    console.log("main already contains upstream/main. Nothing to sync.");
    closeConflictIssue("`main` already contains upstream");
    return;
  }

  const conflicts = conflictingFiles(ROOT, BASE, UPSTREAM);
  if (conflicts.length > 0) {
    console.log(`Merge conflicts in ${conflicts.length} file(s):\n${conflicts.join("\n")}`);
    reportBlocked(
      `merging it into \`main\` conflicts in ${conflicts.length} file(s).`,
      conflicts.map((file) => `- \`${file}\``).join("\n"),
      upstreamSha,
    );
    return;
  }

  const pending = remoteBranchHead();
  if (pending) {
    git(ROOT, ["fetch", "--no-tags", "origin", `refs/heads/${BRANCH}`]);
    if (isAncestor(ROOT, BASE, pending) && isAncestor(ROOT, UPSTREAM, pending)) {
      console.log(`${BRANCH} already merges the current main and upstream.`);
      closeConflictIssue("Upstream merges cleanly again");
      enableAutoMerge(ensurePullRequest(upstreamSha));
      return;
    }
  }

  git(ROOT, ["config", "user.name", "github-actions[bot]"]);
  git(ROOT, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  run("git", ["checkout", "-B", BRANCH, BASE]);
  run("git", [
    "merge",
    "--no-ff",
    "--no-edit",
    "-m",
    `chore: merge upstream T3 Code at ${upstreamSha.slice(0, 12)}`,
    UPSTREAM,
  ]);
  await applyPostMergeSteps();
  run("git", ["add", "--all"]);
  if (git(ROOT, ["status", "--porcelain"])) {
    run("git", ["commit", "-m", "chore: rebrand and regenerate after upstream merge"]);
  }

  try {
    run("git", ["push", "--force", "origin", `HEAD:refs/heads/${BRANCH}`]);
  } catch (error) {
    const workflows = git(ROOT, ["diff", "--name-only", BASE, "HEAD", "--", ".github/workflows"]);
    reportBlocked(
      "GitHub refused the push.",
      workflows
        ? `Upstream changed workflow files, and \`GITHUB_TOKEN\` may not push those. Add an \`UPSTREAM_SYNC_TOKEN\` secret (fine-grained token with Contents, Workflows, Pull requests, and Issues write access) so the sync can push them:\n\n${workflows
            .split("\n")
            .map((file) => `- \`${file}\``)
            .join("\n")}`
        : `\`git push\` failed: ${error instanceof Error ? error.message : String(error)}`,
      upstreamSha,
    );
    process.exitCode = 1;
    return;
  }

  closeConflictIssue("Upstream merges cleanly again");
  enableAutoMerge(ensurePullRequest(upstreamSha));
  if (process.env.DISPATCH_CI === "true") {
    run("gh", ["workflow", "run", "signalbox-ci.yml", "--ref", BRANCH]);
  }
}

if (import.meta.main) {
  await (process.argv.includes("--post-merge") ? applyPostMergeSteps() : main());
}
