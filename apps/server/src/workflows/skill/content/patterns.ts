/** `references/patterns.md`: Proven shapes: supervising agents, polling, approvals, CLIs. */
export const PATTERNS = `# Patterns

Shapes that work. Each has a complete version in \`examples/\`.

## Supervise agents with code

For processes where agents do the work and something has to decide order, quality and completion: build → check → fix → review → land.

- One \`w.agent\` per unit of work, on its own branch: \`worktree: { base: "main", branch: \\\`tickets/\${n}\\\` }\`.
- Read where the work lives from the result (\`branch\`, \`pullRequest\`), or look it up deterministically with \`gh\` in \`w.run\`. Don't parse the agent's prose.
- Send problems back to the same agent with \`thread: built.threadId\`; it keeps its context and worktree.
- Gate on facts, not on the agent saying it's done: CI status from \`gh pr checks\`, an independent reviewer agent (a different model is a good second opinion), and a \`w.judge\` over the reviewer's verdict.
- Confirm every side effect from the source of truth before acting on it: a merge counts when the API says \`merged: true\`, not when a command printed something. Treat a CLI's non-zero exit as failure unless you've checked that command's exit codes (\`gh pr checks\` exits non-zero while checks are pending).
- Bound every loop (\`w.repeat\` with \`max\`) and decide in code what happens when it runs out: usually \`w.ask\` the user with "try again" / "skip it".
- Make runs resumable: derive state from the outside world (open PRs, closed issues) at the start, so running the automation again picks up where it stopped.

\`examples/work-through-tickets.ts\` does all of this for GitHub issues in blocker order.

## Wait for something slow outside

\`w.run\` can block for up to 15 minutes, so poll inside it and loop around it:

\`\`\`ts
const ci = await w.repeat("Wait for CI", { max: 24 }, async (w) => {
  const status = await w.run("Check CI", checkPullRequest, repo, pr.number, 14); // polls for up to 14 minutes
  // Settled?
  if (status.state !== "pending") return w.done(status);
});
\`\`\`

For days-long waits, \`w.sleep\` between checks costs nothing.

## Only handle what's new

Keep a cursor or the handled ids in memory:

\`\`\`ts
const seen: string[] = (await w.recall("Handled items", "seen")) ?? [];
const fresh = items.filter((item) => !seen.includes(item.id));
await w.each("Each new item", fresh, { concurrency: 5 }, async (w, item) => { … });
await w.remember("Save handled items", "seen", [...seen, ...fresh.map((item) => item.id)].slice(-1000));
\`\`\`

## Let the user edit before it's used

\`\`\`ts
const answer = await w.ask("Send this reply?", {
  fields: { reply: { type: "longText", default: draft, required: true } },
  options: ["send", "skip"],
});
if (answer.choice === "send") await w.call("Send it", "gmail.users.messages.send", { … answer.values.reply … });
\`\`\`

## Use any package, API or command-line tool

Anything code can do goes in a \`w.run\` function: npm packages (imported at the top of the file), \`node:child_process\` for CLIs such as \`gh\`, \`git\`, \`ffmpeg\` or \`yt-dlp\` installed on the machine, files on disk. Return small JSON; for big data (a downloaded video), write it to a folder and return the path for the next \`w.run\`.

For HTTP APIs, prefer \`w.call\` when the service is connected in Signalbox (credentials stay on the server), else \`w.http\`.

## React to what happens in Signalbox

Event triggers (see \`triggers.md\`) start a run when something happens in any thread, whichever agent harness it runs on: a turn finishes or fails, a message is sent, an agent asks for input. Filter cheaply with \`where\` in the trigger and return early in code for anything finer.

## Decide when to tell someone

Notifications are decided in code, so they're predictable: \`w.ask\` when a person must decide, \`w.notify\` with \`importance: "high"\` for outcomes they'd act on, \`"low"\` for progress, and one summary at the end of long processes.
`;
