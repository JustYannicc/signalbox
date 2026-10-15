export const meta = {
  name: "Merge gate",
  description:
    "Decides whether a thread's pull request merges: asks you, then merges it, deletes its branch and tells the agent.",
  intent: "ask me before an agent merges its pull request",
} as const;

type Input = {
  threadId?: string;
  url: string;
  repository: string;
  number: number;
  /** What the agent wants the person to know, e.g. what changed and how it was checked. */
  note?: string;
};

/** Tells the agent how it went; it doesn't see the automation. */
async function tell(w, threadId: string, message: string) {
  await w.call("Tell the agent", "signalbox.t3_thread_send", { threadId, mode: "queue", message });
}

export default workflow(async (w, input: Input, trigger: { attach?: { threadId: string } }) => {
  const threadId = input.threadId ?? trigger.attach?.threadId;
  if (!threadId)
    throw new Error("Pass threadId, or start the run attached to the pull request's thread.");
  const pr = `${input.repository}#${input.number} (${input.url})`;

  const answer = await w.ask(`Merge ${input.repository}#${input.number}?`, {
    question: [input.url, input.note].filter(Boolean).join("\n\n"),
    options: ["merge", "not yet"],
    fields: { reason: { type: "longText", label: "Anything to do first?" } },
  });
  if (answer.choice !== "merge") {
    const asked = answer.values.reason
      ? ` They said: ${answer.values.reason} Do that, then call merge_pull_request again.`
      : " Ask them what's missing before calling merge_pull_request again.";
    await tell(w, threadId, `Not merging ${pr} yet.${asked}`);
    return "not yet";
  }

  let merged: { state: string };
  try {
    merged = await w.call("Merge it", "signalbox.pull_request_action", {
      threadId,
      url: input.url,
      action: "merge",
    });
  } catch (error) {
    await tell(
      w,
      threadId,
      `Merging ${pr} failed: ${String(error)}. Fix what it says, then call merge_pull_request again.`,
    );
    return "failed";
  }
  // A host with a merge queue takes it in instead of merging; the branch stays until it lands.
  if (merged.state !== "merged") {
    await tell(
      w,
      threadId,
      `${pr} is approved and the host queued it to merge. Watch it with watch_pull_request; it merges when the queue gets to it.`,
    );
    return "queued";
  }
  let cleanedUp = true;
  try {
    await w.call("Delete its branch", "signalbox.pull_request_action", {
      threadId,
      url: input.url,
      action: "delete-branch",
    });
  } catch {
    cleanedUp = false;
  }
  await tell(
    w,
    threadId,
    `Merged ${pr}${cleanedUp ? " and deleted its branch" : ""}. Wrap up and hand the work back.`,
  );
  return "merged";
});
