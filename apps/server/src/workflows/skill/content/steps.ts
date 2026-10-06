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

Writes or summarizes text. Runs as a short read-only model thread.

### \`w.judge(label, { input, outcomes, question?, timeout?, retry? })\` → one of \`outcomes\`

Makes a decision. \`outcomes\` must be a literal array; each becomes a path in the diagram when you branch on the answer.

### \`w.extract(label, { input, schema, timeout?, retry? })\` → object

Pulls structured data out of text. \`schema\` describes the shape: \`{ total: "number", vendor: "string", lines: [{ item: "string", amount: "number" }] }\`.

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

Without fields it returns the chosen option. Branch on it with \`if\`/\`switch\`; with fields, branch on \`answer.choice\`.

### \`w.notify(label, message, { importance? })\` → null

Tells the user something; the label is the title. \`"high"\` and the default reach their phone; \`"low"\` stays in the app. Decide in code when someone needs to know — a notification nobody acts on is noise.

## The outside world

### \`w.http(label, url | { url, method?, headers?, body?, timeout?, retry? })\` → \`{ status, ok, headers, body }\`

Any HTTP API. JSON bodies are sent and parsed automatically. Any status is a result; check \`ok\`. Network errors, 5xx and 429 retry 3 times by default (\`retry: { attempts, backoff: "exponential" | "fixed" }\`); an \`Idempotency-Key\` is sent. Default timeout 60s; responses over 5 MB fail.

### \`w.call(label, "integration.operation", args?, { connection?, retry? })\` → the API's data

A service the user connected in Signalbox through Executor: \`"gmail.users.messages.list"\`, \`"github.get_file_contents"\`, \`"todoist_com.find_tasks"\`. Credentials stay on the server. With several accounts for one service, name one: \`{ connection: "work" }\`. Discover operations with the user's Executor tools. If nothing is connected, the call fails and says where to connect.

### \`w.run(label, fn, ...args)\` → \`fn\`'s result

Runs a top-level function from this file in Node, in the project's folder: anything code can do — parse files, scrape, crunch data, run CLIs (\`git\`, \`gh\`, \`ffmpeg\`) with \`node:child_process\`. Packages the file imports are installed for it. Helpers that only \`w.run\` functions call can use packages too.

- The function gets plain arguments and returns JSON. Keep results small; write big things to disk and return the path.
- 15 minutes per call. Poll longer work across calls (see \`patterns.md\`).
- A minimal environment: no provider keys or server secrets.
- Only for automations saved from a full-access thread.

## Time and memory

| Step | Returns | Use it to |
|---|---|---|
| \`w.sleep(label, duration \\| { until: iso })\` | null | Wait minutes or days; costs nothing while waiting. |
| \`w.waitFor(label, { event, timeout? })\` | the event's payload, or null on timeout | Wait for a named event, e.g. \`\` \`reply:\${ticket.id}\` \`\`. Agents raise events with the \`automation_emit\` tool. |
| \`w.recall(label, key)\` | the stored value or null | Memory across runs: cursors, already-handled ids. |
| \`w.remember(label, key, value)\` | null | Store it. |
| \`w.start(label, automationName, input?)\` | \`{ runId }\` | Start another automation in the same project (at most 5 deep). |
`;
