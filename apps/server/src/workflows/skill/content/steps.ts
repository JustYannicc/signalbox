/** `references/steps.md`: Every step, its options and what it returns. */
export const STEPS = `# Steps

Every step is \`await w.<verb>(label, …)\`. The label is what people see in the diagram and the run view, so write it for a non-developer: "Draft a reply", not "callLLM". Template literals are fine; their dynamic parts show as \`…\` in the diagram.

Arguments and results are plain JSON. Durations are \`{ seconds?, minutes?, hours?, days? }\` and add up.

## Agents and models

### \`w.agent(label, options)\` → \`{ text, threadId, branch, worktreePath, pullRequest }\`

Hands real work to an agent in a normal Signalbox thread the user can open and steer. The step finishes when the thread's turn ends; \`text\` is its final message.

| Option | Meaning |
|---|---|
| \`prompt\` | Required. The task, with everything the agent needs; it doesn't see the automation. |
| \`provider\`, \`model\` | Which agent: e.g. \`{ provider: "claudeAgent", model: "claude-opus-5-5" }\`, \`{ provider: "codex", model: "gpt-6-astra" }\`. Default: the model of the thread that saved the automation. Naming a provider requires a model. |
| \`effort\` | Reasoning effort, e.g. \`"high"\`. Works for every provider; an unknown value fails with the valid list. |
| \`worktree\` | \`"main"\`: a fresh worktree off that branch. \`{ base: "main", branch: "tickets/12" }\`: also names the new branch; starts from the remote unless \`fromOrigin: false\`. Without it the agent works in the project folder. |
| \`thread\` | A thread id (e.g. an earlier step's \`threadId\`): send the prompt to that thread instead of starting a new one, queued behind any turn it's running. It keeps its context and worktree. Only threads in the automation's project. |
| \`timeout\` | Default 2 hours. Long builds: \`{ hours: 24 }\`. On timeout the turn is interrupted and the step fails. |

\`branch\`, \`worktreePath\` and \`pullRequest\` (\`{ number, url }\` or null) describe where the work lives, so later steps don't have to parse \`text\`.

### \`w.llm(label, { prompt, input?, timeout?, retry? })\` → string

Writes or summarizes the supplied text. In the cloud, model steps call the folder's pool directly without an agent, tools or workspace. Use \`w.agent\` when work needs tools.

### \`w.judge(label, { input, outcomes, question?, timeout?, retry? })\` → one of \`outcomes\`

Makes a decision. \`outcomes\` must be a literal array; each becomes a path in the diagram when you branch on the answer.

Without \`outcomes\`, \`w.judge(label, { input, question? })\` returns \`{ verdict: boolean, reason: string }\`.

### \`w.extract(label, { input, schema, timeout?, retry? })\` → object

Pulls structured data out of text and checks the result against \`schema\`: \`{ total: "number", vendor: "string", lines: [{ item: "string", amount: "number" }] }\`. Shapes support \`"string"\`, \`"number"\`, \`"boolean"\`, \`"null"\`, nested objects and single-item array shapes. Missing fields and wrong types fail the step.

## People

### \`w.ask(label, options)\` → depends on options

Asks the user and waits, for days if needed. It reaches their phone.

| Option | Meaning |
|---|---|
| \`question\` | The text shown. |
| \`options\` | Literal (\`["send", "skip"]\`) or computed (\`dates.map((d) => d.title)\`). Default \`["approve", "reject"]\`, or \`["submit"]\` with fields. |
| \`multi: true\` | Returns an array of chosen options. |
| \`fields\` | A form: \`{ name: { type, label?, default?, required?, options? } }\`, types \`text\`, \`longText\`, \`number\`, \`boolean\`, \`choice\`. Returns \`{ choice, values }\`. A \`longText\` field with \`default: draft\` is how the user edits something before it's used. |
| \`timeout\`, \`onTimeout\` | Stop waiting after a duration and go on with that option (or \`"fail"\`). |
| \`open\` | \`{ threadId, view?: "browser" }\`: what the user can open beside the question, the thread or its agent's live browser. |

Without fields it returns the chosen option. Branch on it with \`if\`/\`switch\`; with fields, branch on \`answer.choice\`.

### \`w.notify(label, message, { importance? })\` → null

Tells the user something; the label is the title. \`"high"\` and the default reach their phone; \`"low"\` stays in the app. Decide in code when someone needs to know — a notification nobody acts on is noise.

## The outside world

### \`w.http(label, url | { url, method?, headers?, body?, timeout?, retry? })\` → \`{ status, ok, headers, body }\`

Any HTTP API. JSON bodies are sent and parsed automatically. Any status is a result; check \`ok\`. Network errors, 5xx and 429 retry 3 times by default (\`retry: { attempts, backoff: "exponential" | "fixed" }\`); an \`Idempotency-Key\` is sent. Default timeout 60s; responses over 5 MB fail.

### \`w.call(label, "integration.operation", args?, { connection?, retry? })\` → the API's data

External-service calls are unavailable in Signalbox Cloud. Use \`w.http\` for an HTTP API or \`w.agent\` when the work needs connected tools.

\`"signalbox.<tool>"\` calls Signalbox's own tools, the ones you have as MCP tools, with the same arguments and results: \`w.call("Wake the agent", "signalbox.t3_thread_send", { threadId, message, mode: "queue" })\`, \`"signalbox.list_thread_pull_requests"\`, \`"signalbox.t3_thread_read"\`. The automation calls without a thread of its own, so pass \`threadId\` where a tool would default to "this thread", and it can't do more than its runtime mode allows. Tools that need a person or a thread's own session (preview, device, \`delegate_task\`, \`request_secret\`, worktree handoff, the automation tools) aren't available; use the steps instead. A \`clientRequestId\` is filled in per step, so a retried step doesn't send twice.

### \`w.run(label, fn, ...args)\` → \`fn\`'s result

Direct host execution is unavailable. Use the GitHub Actions form below.

### \`w.run(label, { on: "github-actions", ref?, secrets?, environment?, timeout? }, fn, ...args)\` → \`fn\`'s result

Runs a top-level function from this file in Node on a GitHub Actions runner of the folder's repository, in a checkout of \`ref\` (default branch by default): CI capacity, the repo's secrets and environments, the same function and result. The step shows the run's jobs and steps live, with their log tails and a link to GitHub.

- Signalbox Cloud only, in a folder added from GitHub. The repo needs Signalbox's step workflow on its default branch: \`references/github-actions.md\` has the file; add it in a pull request for a person to merge.
- Steps run as the GitHub account its owner lent to the folder (folder ⋯ → Lend my GitHub to CI steps). Without a lend the step fails saying so; ask the person to lend it, you can't.
- \`secrets: ["NPM_TOKEN"]\` sets those repository (or \`environment\`) secrets as environment variables for the function. Nothing else is.
- Arguments and the file's \`w.run\` code travel as the run's inputs, which anyone who can read the repo's Actions can see. Pass ids, not secrets or big data (64 KB at most).
- Waits up to 6 hours, GitHub's job limit; \`timeout\` sets less. Cancelling the automation run cancels the GitHub run.

## Time and memory

| Step | Returns | Use it to |
|---|---|---|
| \`w.sleep(label, duration \\| { until: iso })\` | null | Wait minutes or days, once; costs nothing while waiting. Not in a loop or \`w.repeat\`: repeats are a cron trigger. |
| \`w.eventCursor(label)\` | \`{ runId, sequence }\` | Capture this run's event inbox boundary before a read. Pass it as \`after\` to \`w.waitFor\` with a literal \`on\` to skip earlier buffered events while keeping events that arrive after capture. |
| \`w.waitFor(label, { on, where?, after?, timeout? })\` | the event (envelope and fields, as a trigger gets it), or null on timeout | Wait for something to happen in Signalbox: \`{ on: ["pr.checks.failed", "pr.merged"], where: { number: pr.number } }\`. \`on\` and \`where\` work like event triggers (\`triggers.md\`). With a literal \`on\`, events are kept from the run's start, so one that happens between steps isn't missed; a computed \`on\` (\`on: input.event\`) collects only once its step waits. Each event goes to one waiting step. Use \`after\` only with a literal \`on\` to ignore inbox events at or before the cursor sequence. Connected-service \`watch\` waits are unavailable in cloud automations; use \`w.hook\` and \`w.waitFor\` for service webhooks. |
| \`w.waitFor(label, { event, timeout? })\` | the event's payload, or null on timeout | Wait for a named event, e.g. \`\` \`reply:\${ticket.id}\` \`\`. Agents raise events with the \`automation_emit\` tool. |
| \`w.hook(label)\` | \`{ hookId, url, path }\` | A callback link to hand to someone else (a payment provider's "notify me" URL, a form). A request to it is a \`hook.called\` event: \`w.waitFor("Wait for the payment", { on: "hook.called", where: { hookId: link.hookId } })\` gets its \`body\`, \`method\` and \`query\`. \`url\` is null until the server has a public address; \`path\` is relative to it. It stops answering when the run ends. |
| \`w.recall(label, key)\` | the stored value or null | Memory across runs: cursors, already-handled ids. |
| \`w.remember(label, key, value)\` | null | Store it. |
| \`w.start(label, automationName, input?)\` | \`{ runId }\` | Start another automation in the same project (at most 5 deep), or a built-in by its name. |

## Starting over

\`return w.restart(input)\` from the workflow ends the run and starts a fresh one of the same automation (its live version) with \`input\` and an empty history. Long-lived loops use it so they don't replay days of steps: watch for a while, then \`return w.restart({ ...input, since })\`. The new run keeps the trigger, the thread it's attached to, and the run that started it. Restarting more than 30 times an hour fails the run, so wait for something before restarting.
`;
