export const meta = {
  name: "Sync upstream T3 Code",
  description:
    "Every 6 hours an agent merges T3 Code's main into a branch (never a rebase), resolves conflicts per the runbook, keeps the fork's hooks, and opens a PR. The automation sees it through CI and the merge gate merges it.",
  intent:
    "upstream sync runs inside Signalbox every 6 hours: fetch the t3code remote, merge upstream/main into a sync branch, re-run the codemod and generators, check the hooks, open a PR, see it through CI and bots, and let the merge gate merge it",
  triggers: [{ cron: "41 */6 * * *", timezone: "UTC" }],
  overlap: "skip",
} as const;

/** Opus 5.5, high effort (Yannic, #5). */
const AGENT = { provider: "claude_hub", model: "claude-opus-5-5", effort: "high" } as const;

const MERGE = `You keep JustYannicc/signalbox in sync with upstream T3 Code (pingdotgg/t3code). This run was started by the "Sync upstream T3 Code" automation (#5); nobody is watching, so finish on your own or say exactly why you can't.

Read AGENTS.md ("Staying on T3 Code") and docs/operations/upstream-sync.md ("Merging upstream by hand") first. Merge, never rebase. Never squash.

1. Upstream: \`git remote add t3code https://github.com/pingdotgg/t3code.git\` (skip if it exists), \`git config remote.t3code.fetch '+refs/heads/*:refs/remotes/upstream/*'\`, \`git fetch --no-tags t3code main\`, \`git fetch origin main\`. Your branch must start at origin/main: \`git reset --hard origin/main\`.
2. If \`git merge-base --is-ancestor upstream/main origin/main\` succeeds, there's nothing to sync: reply with the first line \`RESULT: up-to-date\` and stop.
3. Merge: \`git merge --no-ff upstream/main -m "chore: merge upstream T3 Code at <first 12 of upstream/main's sha>"\`. Resolve conflicts per the runbook's step 2: take upstream's side where we only renamed wording, and let the codemod rename it again; keep ours where we changed meaning (identity sites, \`signalbox:\` hook lines, fork-owned docs) and port upstream's change by hand; when upstream refactored a hooked file, re-apply the hook to upstream's new code.
4. Post-merge steps: \`corepack pnpm install\`, then \`export PATH="$PWD/node_modules/.bin:$PATH"\` (machines have no global vp, #704), then \`node scripts/upstream-sync/sync.ts --post-merge\`. Commit what it changed as "chore: rebrand and regenerate after upstream merge".
5. Runbook step 4: look for identity values upstream added (\`com.t3tools\`, \`t3code://\`, \`~/.t3\`, \`3773\`, \`"t3"\` executables) in the merge's diff, and route them to Signalbox's.
6. Before publishing, all of these must pass: \`node scripts/rebrand/rebrand.ts --check\`; \`node scripts/upstream-sync/check-hooks.ts --base origin/main --head HEAD\` (every hook kept); and, if you resolved conflicts by hand, typecheck and the tests of the packages you touched (\`vp test run <files>\`, the package's typecheck). Don't run repo-wide checks; CI does.
7. Call \`create_pr\` (ready, not a draft). Title: "chore: merge upstream T3 Code (<12-char sha>)". Body: the upstream range and commit count, each conflict and how you resolved it, hooks you re-applied, identity values you routed, what you ran, and "Merge with a merge commit. Never squash or rebase." End with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".
8. Don't call watch_pull_request or merge_pull_request: the automation waits for CI and wakes you.

Your last message's first line is exactly one of:
- \`RESULT: up-to-date\`
- \`RESULT: pr-opened #<number>\`
- \`RESULT: blocked: <one line>\` when a conflict needs a product decision or something outside the repo is broken; then explain the options and your recommendation.`;

const FIX = (number: number, what: string) =>
  `The upstream sync PR #${number} isn't ready: ${what}. Find the cause and fix it on this branch, the way the runbook says (never rebase, never drop a \`signalbox:\` hook). Reproduce a failing check locally with the job's own command rather than guessing; machines have no gh, so read the job from the workflow file. Then call \`push\`. Don't call merge_pull_request; the automation waits for CI again. If it can't be fixed without a product decision, start your last message with \`RESULT: blocked: <one line>\`.`;


type Check = { name: string; status: string };
/** The sync pull request a run opened, kept so the next run finishes it instead of opening another. */
type SyncPr = { threadId: string; url: string; number: number };
type PullRequest = { state: string; mergeability?: string | null; checks?: Check[] | null; openThreads?: number | null };

const PASSED = ["success", "skipped", "neutral"];

/** The agent's verdict from its last message's first line. */
const verdictOf = (text: string) => text.trim().split("\n")[0] ?? "";

export default workflow(async (w, input: { resume?: SyncPr } | null) => {
  // A sync PR an earlier run left open is finished first; a second sync on top of it would redo its conflicts.
  let open: SyncPr | null = input?.resume ?? (await w.recall("Find the open sync PR", "sync-pr"));
  if (open) {
    try {
      const last: PullRequest = await w.call("Check it's still open", "signalbox.pull_request_read", { threadId: open.threadId, url: open.url });
      if (last.state !== "open") open = null;
    } catch {
      open = null;
    }
  }
  if (!open) {
    const synced = await w.agent("Merge upstream into a branch", { ...AGENT, prompt: MERGE, timeout: { hours: 3 } });
    const verdict = verdictOf(synced.text);
    if (verdict.startsWith("RESULT: up-to-date")) return "Nothing new upstream";
    if (!synced.pullRequest) {
      await w.notify("Upstream sync needs you", `${verdict}\n\nThe agent's thread has the details.`);
      return verdict || "No pull request";
    }
    open = { threadId: synced.threadId, url: synced.pullRequest.url, number: synced.pullRequest.number };
  }
  await w.remember("Remember the sync PR", "sync-pr", open);

  const { number, url, threadId } = open;
  const where = { threadId, number };

  const followed = await w.repeat("See it through to merge", { max: 12 }, async (w) => {
    const pr: PullRequest = await w.call("Read the pull request", "signalbox.pull_request_read", { threadId, url });
    if (pr.state === "merged") return w.done("merged");
    if (pr.state === "closed") return w.done("closed");

    const checks = pr.checks ?? [];
    const running = checks.filter((check) => check.status === "pending");
    if (checks.length === 0 || running.length > 0) {
      await w.waitFor("Wait for CI", {
        on: ["pr.checks.passed", "pr.checks.failed", "pr.conflicted", "pr.merged", "pr.closed"],
        where,
        timeout: { hours: 1 },
      });
      return;
    }

    const failed = checks.filter((check) => !PASSED.includes(check.status));
    const threads = pr.openThreads ?? 0;
    if (failed.length > 0 || pr.mergeability === "conflicting" || threads > 0) {
      const what = [
        failed.length > 0 ? `checks failed: ${failed.map((check) => check.name).join(", ")}` : "",
        pr.mergeability === "conflicting" ? "it conflicts with main; merge origin/main into it" : "",
        threads > 0 ? `${threads} review thread${threads === 1 ? " is" : "s are"} open; answer each, fix what's real, and resolve them` : "",
      ].filter(Boolean).join("; ");
      let fixed: { text: string };
      try {
        fixed = await w.agent("Fix the pull request", { ...AGENT, thread: threadId, prompt: FIX(number, what), timeout: { hours: 2 } });
      } catch (error) {
        // The next run picks this PR up again.
        return w.done(`the fix turn failed (${String(error).slice(0, 200)})`);
      }
      if (verdictOf(fixed.text).startsWith("RESULT: blocked")) return w.done(verdictOf(fixed.text));
      return;
    }

    // Green with nothing open: the folder's Merge gate decides, the same as an agent's merge_pull_request.
    await w.start("Ask the merge gate", "Merge gate", {
      threadId,
      url,
      note: `Upstream T3 Code sync opened by the "Sync upstream T3 Code" automation (#5). CI, Upstream Merge and Upstream Sync passed at the head.`,
    });
    await w.waitFor("Wait for the merge", {
      on: ["pr.merged", "pr.closed", "pr.checks.failed", "pr.conflicted"],
      where,
      timeout: { minutes: 30 },
    });
  });

  const outcome = followed.done ? followed.value : "still open after 12 rounds";
  if (outcome !== "merged") {
    await w.notify("Upstream sync needs you", `#${number} (${url}): ${outcome}. Its thread has the details.`);
  }
  return `#${number}: ${outcome}`;
});
