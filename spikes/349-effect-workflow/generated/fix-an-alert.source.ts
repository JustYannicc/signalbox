export const meta = {
  name: "Fix an alert",
  description:
    "When an alert fires, decides whether to act, has an agent reproduce it as a failing test and fix it, and asks before merging.",
  intent: "fix production alerts before users notice them",
} as const;

type Input = { alertId: string; title: string; users: number; release: string };

export default workflow(async (w, input: Input) => {
  const decision = await w.judge("Is it worth acting on?", {
    input,
    outcomes: ["act", "ignore"],
    question: "Does this alert hurt real users enough to fix it now?",
  });
  if (decision === "ignore") return "ignored";

  // Reproduce first: no fix lands without a failing test.
  const repro = await w.agent("Reproduce it as a failing test", {
    prompt: `Reproduce alert ${input.alertId} (${input.title}) as a failing test. Don't fix anything yet.`,
  });
  const reproduced = await w.judge("Did it reproduce?", {
    input: repro.text,
    outcomes: ["reproduced", "not reproduced"],
  });
  if (reproduced === "not reproduced") {
    await w.ask(`Couldn't reproduce ${input.title}`, {
      question: repro.text,
      options: ["close it", "look again"],
    });
    return "not reproduced";
  }

  const fix = await w.agent("Fix it and open a pull request", {
    prompt:
      "Make the failing test pass, then open a pull request with the trace, the repro and the fix.",
    thread: repro.threadId,
  });

  // The deploy pipeline calls this link once the fix is live.
  const deployed = await w.hook("Deploy callback");
  const answer = await w.ask(`Merge the fix for ${input.title}?`, {
    question: `${fix.pullRequest?.url ?? fix.text}\n\nThe deploy calls ${deployed.path} when it's live.`,
    options: ["merge", "not yet"],
  });
  if (answer !== "merge") return "not merged";
  await w.call("Merge it", "signalbox.pull_request_action", {
    threadId: fix.threadId,
    url: fix.pullRequest?.url,
    action: "merge",
  });

  const live = await w.waitFor("Wait for the deploy", {
    on: "hook.called",
    where: { hookId: deployed.hookId },
    timeout: { minutes: 2 },
  });
  await w.notify(
    "The fix is merged",
    `${input.title} (${input.release}): ${live === null ? "no deploy confirmation within 2 minutes" : "it's live"}`,
  );
  return live === null ? "merged, deploy unconfirmed" : "fixed";
});
