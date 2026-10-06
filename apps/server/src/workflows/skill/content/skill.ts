/** `SKILL.md`: The skill's entry point: when to use it, the loop, rules and where to look next. */
export const SKILL = `---
name: signalbox-automations
description: Use when work should happen without anyone supervising it in Signalbox — on a schedule, on a webhook or an app event (a turn finishing, a message sent), or as a multi-step process that coordinates agents, approvals, APIs or code — or when the user asks to create, change, run, debug or explain an automation.
---

# Signalbox automations

An automation is one TypeScript file. Signalbox draws its diagram from the code and runs it durably: every step's result is journaled, the code replays from the top after each step, and a run survives restarts and can wait days for a person. You write only the code.

**The code is the supervisor.** When the user wants a process — build these tickets in order, triage every email, react whenever a turn fails — write an automation that does it instead of doing the supervising yourself turn by turn. Agents do the judgment-heavy work inside steps; the automation decides order, retries, merges and when to alert someone, deterministically.

This SDK is not in your training data. These files, \`automation_reference\` and the validator are the truth; habits from Temporal, Inngest, Trigger.dev or Cloudflare Workflows are wrong here.

## The loop

Work through it in order. Each item is done when its check holds.

1. **Read what exists.** \`automation_list\`; \`automation_read\` the one you're changing. Done when you know whether you're editing or creating, and its current triggers.
2. **Write the file.** Start from the skeleton below or the closest file in \`references/examples/\`. Set \`meta.intent\` to the user's request in their own words.
3. **Validate.** \`automation_validate\` until it returns zero diagnostics. Several rounds is normal; each diagnostic names the line and the fix. Read the returned outline: every box should make sense to someone who can't code.
4. **Save.** \`automation_save\` goes live immediately. Pass \`draft: true\` only when the user asked to review first; \`automation_publish\` makes a draft live.
5. **Prove it.** \`automation_run\` with a realistic \`input\`, then \`automation_run_read\`. Done when each step's result matches what the user wanted — a succeeded run can still be wrong. Fix and repeat; \`automation_run_retry\` replays a failed run on the fixed code.
6. **Report.** Name, triggers and next run, what the test run did, and when it will notify the user.

## Skeleton

\`\`\`ts
export const meta = {
  name: "Triage support emails",
  description: "Sort each support email, draft a reply, and ask me before sending.",
  intent: "when a support email comes in, sort it and draft a reply I can approve",
  triggers: [{ webhook: true }],
} as const;

export default workflow(async (w, email: { from: string; subject: string; body: string }) => {
  const kind = await w.judge("What kind of email is it?", { input: email, outcomes: ["question", "bug", "spam"] });
  if (kind === "spam") return "ignored";

  const draft = await w.llm("Draft a reply", { prompt: \`Write a short, friendly reply to:\\n\${email.body}\` });
  // Send it? The user can edit the draft first.
  const answer = await w.ask("Send this reply?", {
    fields: { reply: { type: "longText", default: draft, required: true } },
    options: ["send", "skip"],
  });
  if (answer.choice === "send") {
    await w.call("Send the reply", "gmail.users.messages.send", { userId: "me", to: email.from, text: answer.values.reply });
  }
  if (kind === "bug") {
    await w.agent("Look into the bug", { prompt: \`A customer reported: \${email.body}\`, worktree: "main" });
  }
});
\`\`\`

## Rules

The validator enforces each one; breaking it fails with the quoted message.

| Rule | Why | Diagnostic starts with |
|---|---|---|
| Every step is \`await w.<verb>("Label", …)\`; the label is a string or template literal | The label is the box a non-developer reads | "The first argument must be a label" |
| Workflow code has no \`fetch\`, timers, \`process\` or packages; use \`w.http\`, \`w.sleep\`, \`w.run\` | Workflow code replays; side effects must be journaled steps | "fetch isn't available" |
| Packages and the machine only inside top-level functions passed to \`w.run\` (and helpers only they call) | \`w.run\` executes in Node with the file's imports installed | "… is an imported package" |
| No steps inside \`.map\`/\`.forEach\`/other callbacks; use \`w.each\`, \`w.parallel\`, \`w.repeat\` or a \`for\` loop | Steps need a stable place in the diagram | "Steps can't run inside a callback" |
| Inside \`each\`/\`parallel\`/\`repeat\`, use the receiver the callback gets | Each iteration is tracked on its own | "Pass w, the receiver this callback gets" |
| \`concurrency\` and \`max\` are literal numbers; \`meta\` is a plain literal | The diagram and scheduler read them without running code | "must be a literal" |

\`Date.now()\`, \`new Date()\`, \`Math.random()\` and \`crypto.randomUUID()\` are safe: they replay identically. Plain promises, closures, \`Map\`s and \`Promise.all\` work too, so you can coordinate concurrent work in ordinary code.

## Habits that are wrong here

| You'd write | Write instead |
|---|---|
| \`step.run("id", async () => …)\`, \`ctx.run\`, \`step.do\` | a verb: \`await w.http("Fetch the page", url)\` or \`await w.run("Parse it", parse, url)\` |
| \`await fetch(url)\` in the workflow | \`await w.http("Fetch …", url)\` |
| \`setTimeout\`, or polling an agent in a loop | \`await w.sleep(…)\`; \`w.agent\` already waits for the thread to finish |
| \`items.map(async (item) => w.agent(…))\` | \`await w.each("Each item", items, { concurrency: 3 }, async (w, item) => { … })\` |
| Reading an agent's text to find its branch or PR | \`const built = await w.agent(…)\`; use \`built.branch\`, \`built.pullRequest\` |
| A new agent to fix what the last one did | \`w.agent("Fix it", { prompt, thread: built.threadId })\` continues the same thread |
| Supervising a long process yourself, turn by turn | an automation that encodes the process |
| Polling \`gh pr checks\` in a loop to watch CI | \`w.waitFor("…", { on: ["pr.checks.failed", "pr.checks.passed"], where: { number } })\` |
| A loop that runs for days | \`return w.restart(input)\` every few passes |

## References

| Task | Read |
|---|---|
| Every step, its options and what it returns | \`references/steps.md\` |
| Branches, loops, concurrency, failures, helpers | \`references/control-flow.md\` |
| Schedules, webhooks, app events, manual input | \`references/triggers.md\` |
| Reading a run, fixing and retrying it, drafts | \`references/runs.md\` |
| Proven shapes: supervising agents and threads, polling, approvals, CLIs | \`references/patterns.md\` |
| Complete automations to start from | \`references/examples/\` |

In a harness without these files, \`automation_reference\` returns the same content: call it with no topic for this page, or \`{ topic: "steps" }\` and so on.
`;
