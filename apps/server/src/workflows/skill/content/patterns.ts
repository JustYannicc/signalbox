/** `references/patterns.md`: Proven shapes: supervising agents, polling, approvals, CLIs. */
export const PATTERNS = `# Patterns

Shapes that work. Each has a complete version in \`examples/\`.

## Supervise agents with code

For processes where agents do the work and something has to decide order, quality and completion: build → check → fix → review → land. Code steps use GitHub Actions after the setup in \`github-actions.md\`. For \`gh\`, provision a repository \`GH_TOKEN\` secret with the target-repository permissions the commands need, and pass \`secrets: ["GH_TOKEN"]\` on each step. Lending GitHub authenticates dispatch, not the CLI inside the job.

- One \`w.agent\` per unit of work, on its own branch: \`worktree: { base: "main", branch: \\\`tickets/\${n}\\\` }\`.
- Read where the work lives from the result (\`branch\`, \`pullRequest\`), or look it up deterministically with \`gh\` in \`w.run(label, { on: "github-actions", secrets: ["GH_TOKEN"] }, fn, ...args)\`. Don't parse the agent's prose.
- Send problems back to the same agent with \`thread: built.threadId\`; it keeps its context and worktree.
- Gate on facts, not on the agent saying it's done: CI status from \`gh pr checks\`, an independent reviewer agent (a different model is a good second opinion), and a \`w.judge\` over the reviewer's verdict.
- Confirm every side effect from the source of truth before acting on it: a merge counts when the API says \`merged: true\`, not when a command printed something. Treat a CLI's non-zero exit as failure unless you've checked that command's exit codes (\`gh pr checks\` exits non-zero while checks are pending).
- Bound every loop (\`w.repeat\` with \`max\`) and decide in code what happens when it runs out: usually \`w.ask\` the user with "try again" / "skip it".
- Make runs resumable: derive state from the outside world (open PRs, closed issues) at the start, so running the automation again picks up where it stopped.

\`examples/work-through-tickets.ts\` does all of this for GitHub issues in blocker order.

## Wait for something, as an agent

An agent that needs to wait for one thing (CI, another thread, a reply, a payment, tomorrow) calls the \`wait_for\` tool and ends its turn, instead of polling, sleeping or writing its own automation: \`wait_for({ until: "checks on #12 to finish", on: ["pr.checks.passed", "pr.checks.failed"], where: { number: 12 } })\`. It runs the built-in "Wait for" (\`examples/wait-for.ts\`) attached to the thread, which sends one message when it happens. \`callback: true\` returns a link to hand out; \`at\` waits for a time. \`list_waits\` and \`stop_waiting\` manage them. For a pull request the agent owns, \`watch_pull_request\` runs "Watch pull request" instead, which keeps waking it on every check, comment and review until it merges.

## Merge through the folder's gate

An agent doesn't merge its own pull request. It calls \`merge_pull_request({ url, note })\` and ends its turn; that runs the built-in "Merge gate" (\`examples/merge-gate.ts\`) attached to the thread. By default it reads the evidence at the head commit: an unready pull request (failed or running checks, open review threads, requested changes, a draft, a conflict) goes back to the agent; a ready one merges by itself unless it's hard to undo (a changed path in its \`HARD_TO_UNDO\` list, or the agent passed \`askBecause\`), and then it asks the person first. It merges only that commit, deletes the branch and wakes the agent with the outcome. Only Signalbox's own automations and ones a person published in the app can merge, so to change who decides in a project (ask every time, more hard-to-undo paths, a reviewer agent first), \`automation_customize\` the gate, save the change with \`draft: true\`, and ask the user to publish it.

## Supervise a thread or pull request

To keep an eye on one thread's work after its agent's turn ends (CI on its pull request, a deploy, a review), start a run attached to the thread:

\`\`\`
automation_run({ automationId, input: { number: 12 }, attach: { threadId, key: "pr:12", label: "Watching PR #12" } })
\`\`\`

- While it runs, the thread shows it as background work and stays in Working, labelled by the step it's waiting on. Settling, archiving or deleting the thread, or Stop on it, cancels the run. A second start with the same \`key\` returns the running one.
- In the code, wait for Signalbox events instead of polling: \`w.waitFor("Wait for CI", { on: ["pr.checks.failed", "pr.checks.passed", "pr.merged", "pr.closed"], where: { threadId, number }, timeout: { minutes: 30 } })\`. On a timeout, check the source of truth before going on.
- Wake the thread's agent with what it needs to act: \`w.call("Wake the agent", "signalbox.t3_thread_send", { threadId, mode: "queue", message })\`. It doesn't see the automation, so say what happened and what to do.
- Loop with \`w.repeat\` and \`return w.restart(input)\` after a number of passes, so a watch that lasts days doesn't replay its whole history.

The built-in "Watch pull request" (\`builtin:watch-pull-request\`, \`examples/watch-pull-request.ts\`) does all of this. Run it as is, or \`automation_customize\` it to change what it does.

## Wait for something slow outside

For an external system without an event or webhook, a GitHub Actions step can poll it with a bounded function. GitHub Actions setup is required. This \`gh\` helper also needs a repository \`GH_TOKEN\` secret with permission to read the target repository's checks:

\`\`\`ts
const ci = await w.repeat("Wait for CI", { max: 24 }, async (w) => {
  const status = await w.run("Check CI", { on: "github-actions", secrets: ["GH_TOKEN"] }, checkPullRequest, repo, pr.number, 14);
  if (status.state !== "pending") return w.done(status);
});
\`\`\`

Don't sleep between checks: a loop that sleeps is rejected, because every pass is billed as a step. For days-long waits, wait on an event with \`w.waitFor\` and a \`timeout\`, or check on a schedule (\`triggers: [{ cron: … }]\`) and keep what you've seen with \`w.remember\`.

## Only handle what's new

Read items through \`w.http\` or an agent step, then keep a cursor or the handled ids in memory:

\`\`\`ts
const seen: string[] = (await w.recall("Handled items", "seen")) ?? [];
const fresh = items.filter((item) => !seen.includes(item.id));
await w.each("Each new item", fresh, { concurrency: 5 }, async (w, item) => { … });
await w.remember("Save handled items", "seen", [...seen, ...fresh.map((item) => item.id)].slice(-1000));
\`\`\`

## Let the user edit before it's used

\`\`\`ts
const answer = await w.ask("Keep this reply?", {
  fields: { reply: { type: "longText", default: draft, required: true } },
  options: ["keep", "skip"],
});
if (answer.choice === "keep") {
  await w.notify("Reply ready to send", \`To: \${email.from}\\n\${answer.values.reply}\`);
}
\`\`\`

## Use any package, API or command-line tool

Run npm packages, Node APIs and command-line tools with \`w.run(label, { on: "github-actions" }, fn, ...args)\`. Set up the repository workflow and lend a GitHub account first (\`github-actions.md\`). Each step runs in its own GitHub job, so local file paths are not shared between steps. Return small JSON.

Use \`w.http\` for HTTP APIs. Connected services other than the GitHub integration are not available in cloud automations yet. External-service \`w.call\` and connected-service watches are unavailable; \`w.call\` supports Signalbox tools.

## React to what happens in Signalbox

Event triggers (see \`triggers.md\`) start a run when something happens in any thread, whichever agent harness it runs on: a turn finishes or fails, a message is sent, an agent asks for input. Filter cheaply with \`where\` in the trigger and return early in code for anything finer.

## Decide when to tell someone

Notifications are decided in code, so they're predictable: \`w.ask\` when a person must decide, \`w.notify\` with \`importance: "high"\` for outcomes they'd act on, \`"low"\` for progress, and one summary at the end of long processes.
`;
