export const meta = {
  name: "Merge gate",
  description: "Decides whether a thread's pull request merges: sends it back to the agent until checks and reviews are done, merges it by itself when it's easy to undo, and asks you first when it's hard to undo or undecided.",
  intent: "merge an agent's pull request once it's ready, and ask me first about anything hard to undo; merge upstream T3 Code syncs by themselves once they're good (#5)",
} as const;

/** true: a person approves every merge, however ready and small. */
const ASK_EVERY_TIME = false;

/**
 * Changes a person approves before they merge, because merging them is hard
 * to take back. A changed path matching `paths` makes the gate ask. Most match
 * a word anywhere in the path on purpose: a needless question costs a tap, a
 * missed one merges a migration nobody saw. Add this folder's own, e.g.
 * infrastructure or billing.
 */
const HARD_TO_UNDO = [
  {
    why: "a database migration",
    paths: /migrat|\.sql$|(^|\/)schema\.(prisma|rb)$/i,
  },
  // Cloudflare's config also holds Durable Object migrations, which can delete their data.
  { why: "the Workers config (wrangler)", paths: /(^|\/)wrangler\.(jsonc?|toml)$/i },
  {
    why: "sign-in or access control",
    paths: /auth(?!ors?([^a-z]|$))|log[-_]?in(?!g|put|dex)|sign[-_]?in(?!g|put|dex)|permission|access[-_]?control|rbac|credential|secret|(^|[\/._-])(sessions?|acl|roles?|scopes?|grants?)([\/._-]|$)/i,
  },
  {
    why: "deleting or rewriting stored data",
    paths: /backfill|purge|retention|(^|[^s])wipe/i,
  },
];

/**
 * Upstream T3 Code syncs (Yannic, #5). Merging upstream almost always touches
 * paths HARD_TO_UNDO lists, yet a sync merged with a merge commit is undone by
 * reverting that one commit. So a pull request from a branch of this
 * repository into main whose Upstream Sync check passed (CI ran it because the
 * head merges upstream, and it passes only when the Upstream Merge job did and
 * every `signalbox:` hook line survived) merges without asking. Everything
 * else in this gate still applies: CI green, reviews resolved, no conflict.
 */
const UPSTREAM_SYNC = { check: "Upstream Sync", base: "main" };

function isUpstreamSync(pr: PullRequest): boolean {
  const ownBranch = pr.headRepository?.toLowerCase() === pr.repository.toLowerCase();
  const passed = (pr.checks ?? []).some((check) => check.name === UPSTREAM_SYNC.check && check.status === "success");
  return ownBranch && pr.baseBranch === UPSTREAM_SYNC.base && passed;
}

/** Check results that count as passed; anything else still runs or failed. */
const PASSED = ["success", "skipped", "neutral"];

type Input = {
  threadId?: string;
  url: string;
  /** What the agent wants a person to know: what changed and how it was checked. */
  note?: string;
  /** The agent's reason a person should decide, when it has one. */
  askBecause?: string;
};
type Check = { name: string; status: string; url: string | null };
/** What the host says. Parts it couldn't read are null or missing. */
type PullRequest = {
  repository: string;
  number: number;
  title: string;
  state: string;
  headSha: string | null;
  headBranch?: string;
  baseBranch?: string;
  /** The head branch's repository; another one's is a fork. */
  headRepository?: string | null;
  isDraft?: boolean | null;
  mergeability?: string | null;
  reviewDecision?: string | null;
  checks?: Check[] | null;
  openThreads?: number | null;
  files?: string[] | null;
};

/** Tells the agent how it went; it doesn't see the automation. */
async function tell(w, threadId: string, message: string) {
  await w.call("Tell the agent", "signalbox.t3_thread_send", { threadId, mode: "queue", message });
}

const names = (checks: Check[]) => checks.map((check) => check.name).join(", ");

/** What the agent has to fix before anyone looks: failed or running checks, open reviews, a draft, a conflict. */
function missing(pr: PullRequest): string[] {
  const checks = pr.checks ?? [];
  const failed = checks.filter((check) => check.status !== "pending" && !PASSED.includes(check.status));
  const running = checks.filter((check) => check.status === "pending");
  return [
    pr.isDraft ? "it's still a draft" : "",
    pr.mergeability === "conflicting" ? "it conflicts with its base branch" : "",
    failed.length > 0 ? `checks failed: ${names(failed)}` : "",
    running.length > 0 ? `checks are still running: ${names(running)}` : "",
    pr.openThreads ? `${pr.openThreads} review thread${pr.openThreads === 1 ? " is" : "s are"} unresolved` : "",
    pr.reviewDecision === "changes-requested" ? "a reviewer requested changes" : "",
    pr.reviewDecision === "review-required" ? "it still needs the review the branch requires" : "",
  ].filter(Boolean);
}

/** Why a person decides this one rather than the gate; empty when nothing says so. */
function reasonsToAsk(pr: PullRequest, input: Input): string[] {
  const sync = isUpstreamSync(pr);
  const files = sync ? [] : (pr.files ?? []);
  const risky = HARD_TO_UNDO.flatMap((rule) => {
    const hits = files.filter((path) => rule.paths.test(path));
    return hits.length === 0 ? [] : [`it changes ${rule.why} (${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ", …" : ""})`];
  });
  return [
    ASK_EVERY_TIME ? "this folder asks before every merge" : "",
    input.askBecause ? `the agent asks: ${input.askBecause}` : "",
    ...risky,
    // Evidence the host didn't give is evidence nobody has; a person decides without it.
    pr.headSha ? "" : "the host didn't say which commit is the head, so nothing pins what merges",
    pr.checks ? "" : "the checks at the head couldn't be read",
    pr.checks && pr.checks.length === 0 ? "no checks ran at the head" : "",
    pr.openThreads === null || pr.openThreads === undefined ? "the review threads couldn't be read" : "",
    pr.files || sync ? "" : "the changed files couldn't be read, so it isn't known to be easy to undo",
  ].filter(Boolean);
}

/** The evidence as a person reads it. */
function evidence(pr: PullRequest, commit: string): string {
  const checks = pr.checks ?? [];
  return [
    checks.length > 0 ? `Checks: all ${checks.length} passed at ${commit}.` : "",
    pr.openThreads === 0 ? "Review threads: all resolved." : "",
    pr.reviewDecision === "approved" ? "Review: approved." : "",
    pr.files ? `Changes ${pr.files.length} file${pr.files.length === 1 ? "" : "s"}.` : "",
  ].filter(Boolean).join(" ");
}

export default workflow(async (w, input: Input, trigger: { attach?: { threadId: string } }) => {
  const threadId = input.threadId ?? trigger.attach?.threadId;
  if (!threadId) throw new Error("Pass threadId, or start the run attached to the pull request's thread.");
  // Everything decided here comes from the host, never from the input.
  const pr: PullRequest = await w.call("Read the pull request", "signalbox.pull_request_read", { threadId, url: input.url });
  const name = `${pr.repository}#${pr.number} (${input.url})`;
  const commit = pr.headSha ? pr.headSha.slice(0, 7) : "its current head";
  if (pr.state !== "open") {
    await tell(w, threadId, `${name} is already ${pr.state}; there's nothing to merge.`);
    return pr.state;
  }

  const notReady = missing(pr);
  if (notReady.length > 0) {
    await tell(w, threadId, `Not merging ${name} yet: ${notReady.join("; ")}. Fix that (watch_pull_request wakes you when checks finish), then call merge_pull_request again.`);
    return "not ready";
  }

  const reasons = reasonsToAsk(pr, input);
  if (reasons.length > 0) {
    // The approval is for this commit; anything pushed later needs its own.
    const answer = await w.ask(`Merge ${pr.repository}#${pr.number}?`, {
      question: [
        pr.title,
        input.url,
        pr.headSha ? `At ${commit}. ${evidence(pr, commit)}` : evidence(pr, commit),
        `Asking because ${reasons.join("; ")}.`,
        input.note,
      ].filter(Boolean).join("\n\n"),
      options: ["merge", "not yet"],
      fields: { reason: { type: "longText", label: "Anything to do first?" } },
    });
    if (answer.choice !== "merge") {
      const asked = answer.values.reason
        ? ` They said: ${answer.values.reason} Do that, then call merge_pull_request again.`
        : " Ask them what's missing before calling merge_pull_request again.";
      await tell(w, threadId, `Not merging ${name} yet.${asked}`);
      return "not yet";
    }
  }

  let merged: { state: string; moved: boolean };
  try {
    merged = await w.call("Merge it", "signalbox.pull_request_action", {
      threadId,
      url: input.url,
      action: "merge",
      // Never squash or rebase a sync: that drops upstream's history (docs/operations/upstream-sync.md).
      ...(isUpstreamSync(pr) ? { mergeMethod: "merge" } : {}),
      ...(pr.headSha ? { expectedHeadSha: pr.headSha } : {}),
    });
  } catch (error) {
    await tell(w, threadId, `Merging ${name} failed: ${String(error)}. Fix what it says, then call merge_pull_request again.`);
    return "failed";
  }
  if (merged.moved) {
    await tell(w, threadId, `Not merging ${name}: new commits landed after ${commit}, which is what was checked. Call merge_pull_request again so the gate looks at what's there now.`);
    return "moved";
  }
  // A host with a merge queue takes it in instead of merging; the branch stays until it lands.
  if (merged.state !== "merged") {
    await tell(w, threadId, `${name} passed the gate and the host queued it to merge. Watch it with watch_pull_request; it merges when the queue gets to it.`);
    return "queued";
  }
  let cleanedUp = true;
  try {
    await w.call("Delete its branch", "signalbox.pull_request_action", { threadId, url: input.url, action: "delete-branch" });
  } catch {
    cleanedUp = false;
  }
  const how = reasons.length > 0 ? "approved" : isUpstreamSync(pr) ? "an upstream sync that passed its checks" : "ready and easy to undo";
  await tell(w, threadId, `Merged ${name} at ${commit} (${how})${cleanedUp ? " and deleted its branch" : ""}. Wrap up and hand the work back.`);
  return "merged";
});
