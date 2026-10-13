/**
 * "Watch pull request": what upstream's PR watch does, as an automation
 * people can read and change. Run it attached to the thread that owns the
 * pull request; it wakes that thread's agent when checks fail or pass or the
 * branch conflicts, and ends when the pull request merges or closes.
 */
export const WATCH_PULL_REQUEST = `export const meta = {
  name: "Watch pull request",
  description: "Watches a thread's pull request: wakes the thread's agent when checks fail or pass or the branch conflicts, and stops when it merges or closes.",
  intent: "watch this pull request and wake the agent when something needs it",
} as const;

type Input = { threadId?: string; number: number; repository?: string };
type News = { event: string; number: number; url: string; title: string | null };

/** What the agent is told; it doesn't see the automation. */
function wakeMessage(news: News) {
  const pr = \`pull request #\${news.number} (\${news.url})\`;
  if (news.event === "pr.checks.failed") return \`Checks failed on \${pr}. Look at the failures and fix them.\`;
  if (news.event === "pr.conflicted") return \`\${pr} now conflicts with its base branch. Bring the base in and resolve the conflicts.\`;
  return \`Checks passed on \${pr}. Check it's ready, then carry on with what you were asked to do with it.\`;
}

export default workflow(async (w, input: Input, trigger: { attach?: { threadId: string } }) => {
  const threadId = input.threadId ?? trigger.attach?.threadId;
  if (!threadId) throw new Error("Pass threadId, or start the run attached to the pull request's thread.");
  const where = input.repository
    ? { threadId, number: input.number, repository: input.repository }
    : { threadId, number: input.number };

  const watched = await w.repeat("Watch the pull request", { max: 20 }, async (w) => {
    const news: News | null = await w.waitFor("Wait for news on the pull request", {
      on: ["pr.checks.failed", "pr.checks.passed", "pr.conflicted", "pr.merged", "pr.closed"],
      where,
      timeout: { minutes: 30 },
    });
    // Quiet for half an hour?
    if (news === null) {
      const listed = await w.call("Check it's still open", "signalbox.list_thread_pull_requests", { threadId });
      const pr = listed.pullRequests.find((entry: { number: number }) => entry.number === input.number);
      if (!pr) return w.done("unlinked");
      if (pr.state === "merged" || pr.state === "closed") return w.done(pr.state);
      return;
    }
    // Merged or closed?
    if (news.event === "pr.merged") return w.done("merged");
    if (news.event === "pr.closed") return w.done("closed");
    await w.call("Wake the agent", "signalbox.t3_thread_send", {
      threadId,
      mode: "queue",
      message: wakeMessage(news),
    });
  });
  if (watched.done) return \`Pull request #\${input.number}: \${watched.value}\`;
  // A long watch starts over, so its history stays short.
  return w.restart(input);
});
`;
