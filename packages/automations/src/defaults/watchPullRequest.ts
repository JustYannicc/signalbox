/**
 * Comment-only wakes in a row before a watch stops: upstream's PR watch limit
 * (`PULL_REQUEST_WATCH_WAKE_LIMIT`, which a server test holds this to).
 */
export const WATCH_WAKE_LIMIT = 10;

/**
 * "Watch pull request": what upstream's PR watch does, as an automation
 * people can read and change. Run it attached to the thread that owns the
 * pull request; it wakes that thread's agent when checks fail or pass,
 * someone else comments or reviews, or the branch conflicts, and ends when
 * the pull request merges or closes. `watch_pull_request` starts it.
 */
export const WATCH_PULL_REQUEST = `export const meta = {
  name: "Watch pull request",
  description: "Watches a thread's pull request: wakes the thread's agent when checks fail or pass, someone else comments or reviews, or the branch conflicts, and stops when it merges or closes.",
  intent: "watch this pull request and wake the agent when something needs it",
} as const;

type Input = {
  threadId?: string;
  number: number;
  repository?: string;
  /** Links the pull request to the thread first, when it isn't yet. */
  url?: string;
  /** Comment-only wakes and failed reads in a row so far, carried over a restart. */
  quietWakes?: number;
  readFailures?: number;
};
type Remark = { author: string | null; body: string | null; path: string | null; reviewState: string | null; url: string | null };
type FailedCheck = { name: string; status: string; url: string | null };
type News = {
  event: string;
  number: number;
  url: string;
  failedChecks?: FailedCheck[] | null;
  remarks?: Remark[] | null;
};

/** Comment-only wakes in a row before the watch stops, so a chatty bot can't loop the agent. */
const WAKE_LIMIT = ${WATCH_WAKE_LIMIT};
/** Reads in a row that may fail before the watch gives up. */
const READ_FAILURE_LIMIT = 8;
const LISTED = 10;

function listed<T>(items: T[], line: (item: T) => string) {
  const lines = items.slice(0, LISTED).map(line);
  if (items.length > LISTED) lines.push(\`- and \${items.length - LISTED} more\`);
  return lines;
}

/** What the agent is told; it doesn't see the automation. */
function wakeMessage(news: News, stopping: boolean) {
  const pr = \`pull request #\${news.number} (\${news.url})\`;
  const lines: string[] = [];
  if (news.event === "pr.checks.failed") {
    lines.push(\`Checks failed on \${pr}:\`);
    lines.push(...listed(news.failedChecks ?? [], (check) => \`- \${check.name}\${check.status === "failure" ? "" : \` (\${check.status})\`}\${check.url ? \` \${check.url}\` : ""}\`));
    lines.push("Look at the failures and fix them.");
  } else if (news.event === "pr.conflicted") {
    lines.push(\`\${pr} now conflicts with its base branch. Bring the base in and resolve the conflicts.\`);
  } else if ((news.event === "pr.commented" || news.event === "pr.reviewed") && !news.remarks) {
    lines.push(\`There's new activity on \${pr}, but I couldn't read it. Look at the conversation on the host.\`);
  } else if (news.event === "pr.commented" || news.event === "pr.reviewed") {
    lines.push(\`New \${news.event === "pr.reviewed" ? "reviews" : "comments"} on \${pr}:\`);
    lines.push(...listed(news.remarks ?? [], (remark) => {
      const where = remark.path ? \` on \${remark.path}\` : "";
      const said = remark.body ? \`"\${remark.body.slice(0, 200)}"\` : (remark.reviewState ?? "reviewed");
      return \`- \${remark.author ?? "someone"}\${where}: \${said}\${remark.url ? \` \${remark.url}\` : ""}\`;
    }));
    lines.push("Look into each one and act on it as your task requires.");
  } else {
    lines.push(\`Checks passed on \${pr}. Check it's ready, then carry on with what you were asked to do with it.\`);
  }
  lines.push(
    "",
    stopping
      ? \`I stopped watching after \${WAKE_LIMIT} comment-only updates in a row. Call watch_pull_request to watch it again.\`
      : "I keep watching and wake you on the next change, so end your turn when you're done. Call unwatch_pull_request when you hand the work back.",
  );
  return lines.join("\\n");
}

export default workflow(async (w, input: Input, trigger: { attach?: { threadId: string } }) => {
  const threadId = input.threadId ?? trigger.attach?.threadId;
  if (!threadId) throw new Error("Pass threadId, or start the run attached to the pull request's thread.");
  const where = input.repository
    ? { threadId, number: input.number, repository: input.repository }
    : { threadId, number: input.number };
  // pr.* events come from the thread's linked pull requests.
  if (input.url) await w.call("Link it to the thread", "signalbox.link_pull_request", { threadId, url: input.url });

  let quiet = input.quietWakes ?? 0;
  let failures = input.readFailures ?? 0;
  const watched = await w.repeat("Watch the pull request", { max: 20 }, async (w) => {
    const news: News | null = await w.waitFor("Wait for news on the pull request", {
      on: ["pr.checks.failed", "pr.checks.passed", "pr.conflicted", "pr.commented", "pr.reviewed", "pr.merged", "pr.closed"],
      where,
      timeout: { minutes: 30 },
    });
    // Quiet for half an hour?
    if (news === null) {
      let listed: { pullRequests: Array<{ number: number; state: string | null }> };
      try {
        listed = await w.call("Check it's still open", "signalbox.list_thread_pull_requests", { threadId });
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures < READ_FAILURE_LIMIT) return;
        // Tell the agent once, rather than watching something that can't be read.
        await w.call("Tell the agent it stopped", "signalbox.t3_thread_send", {
          threadId,
          mode: "queue",
          message: \`I couldn't read pull request #\${input.number} \${READ_FAILURE_LIMIT} times in a row (\${String(error)}), so I stopped watching it. Call watch_pull_request to try again.\`,
        });
        return w.done("unreadable");
      }
      const pr = listed.pullRequests.find((entry) => entry.number === input.number);
      if (!pr) return w.done("unlinked");
      if (pr.state === "merged" || pr.state === "closed") return w.done(pr.state);
      return;
    }
    // Merged or closed?
    if (news.event === "pr.merged") return w.done("merged");
    if (news.event === "pr.closed") return w.done("closed");
    // Checks and conflicts are progress; only comments count toward the limit.
    quiet = news.event === "pr.commented" || news.event === "pr.reviewed" ? quiet + 1 : 0;
    const stopping = quiet >= WAKE_LIMIT;
    await w.call("Wake the agent", "signalbox.t3_thread_send", {
      threadId,
      mode: "queue",
      message: wakeMessage(news, stopping),
    });
    if (stopping) return w.done("too many comments");
  });
  if (watched.done) return \`Pull request #\${input.number}: \${watched.value}\`;
  // A long watch starts over, so its history stays short.
  return w.restart({
    threadId: input.threadId,
    number: input.number,
    repository: input.repository,
    quietWakes: quiet,
    readFailures: failures,
  });
});
`;
