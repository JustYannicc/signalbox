/**
 * "Merge gate": what happens when an agent asks to merge its pull request
 * (`merge_pull_request`). By default a person decides: it asks, as a
 * needs-you, then merges and deletes the branch, and tells the agent either
 * way. A project that wants something else (merge on green, a second
 * reviewer agent first) customizes it like any automation, so the gate is the
 * folder's own decision.
 */
export const MERGE_GATE = `export const meta = {
  name: "Merge gate",
  description: "Decides whether a thread's pull request merges: asks you, then merges it, deletes its branch and tells the agent.",
  intent: "ask me before an agent merges its pull request",
} as const;

type Input = {
  threadId?: string;
  url: string;
  /** What the agent wants the person to know, e.g. what changed and how it was checked. */
  note?: string;
};
type PullRequest = { repository: string; number: number; title: string; state: string; headSha: string | null };

/** Tells the agent how it went; it doesn't see the automation. */
async function tell(w, threadId: string, message: string) {
  await w.call("Tell the agent", "signalbox.t3_thread_send", { threadId, mode: "queue", message });
}

export default workflow(async (w, input: Input, trigger: { attach?: { threadId: string } }) => {
  const threadId = input.threadId ?? trigger.attach?.threadId;
  if (!threadId) throw new Error("Pass threadId, or start the run attached to the pull request's thread.");
  // What the person sees comes from the host, never from the input.
  const pr: PullRequest = await w.call("Read the pull request", "signalbox.pull_request_read", { threadId, url: input.url });
  const name = \`\${pr.repository}#\${pr.number} (\${input.url})\`;
  const commit = pr.headSha ? pr.headSha.slice(0, 7) : "its current head";

  // The approval is for this commit; anything pushed later needs its own.
  const answer = await w.ask(\`Merge \${pr.repository}#\${pr.number}?\`, {
    question: [pr.title, input.url, \`At \${commit}.\`, input.note].filter(Boolean).join("\\n\\n"),
    options: ["merge", "not yet"],
    fields: { reason: { type: "longText", label: "Anything to do first?" } },
  });
  if (answer.choice !== "merge") {
    const asked = answer.values.reason
      ? \` They said: \${answer.values.reason} Do that, then call merge_pull_request again.\`
      : " Ask them what's missing before calling merge_pull_request again.";
    await tell(w, threadId, \`Not merging \${name} yet.\${asked}\`);
    return "not yet";
  }

  let merged: { state: string; moved: boolean };
  try {
    merged = await w.call("Merge it", "signalbox.pull_request_action", {
      threadId,
      url: input.url,
      action: "merge",
      ...(pr.headSha ? { expectedHeadSha: pr.headSha } : {}),
    });
  } catch (error) {
    await tell(w, threadId, \`Merging \${name} failed: \${String(error)}. Fix what it says, then call merge_pull_request again.\`);
    return "failed";
  }
  if (merged.moved) {
    await tell(w, threadId, \`Not merging \${name}: new commits landed after it was approved at \${commit}. Call merge_pull_request again so they can approve what's there now.\`);
    return "moved";
  }
  // A host with a merge queue takes it in instead of merging; the branch stays until it lands.
  if (merged.state !== "merged") {
    await tell(w, threadId, \`\${name} is approved and the host queued it to merge. Watch it with watch_pull_request; it merges when the queue gets to it.\`);
    return "queued";
  }
  let cleanedUp = true;
  try {
    await w.call("Delete its branch", "signalbox.pull_request_action", { threadId, url: input.url, action: "delete-branch" });
  } catch {
    cleanedUp = false;
  }
  await tell(w, threadId, \`Merged \${name}\${cleanedUp ? " and deleted its branch" : ""}. Wrap up and hand the work back.\`);
  return "merged";
});
`;
