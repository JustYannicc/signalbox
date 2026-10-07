/** `references/control-flow.md`: Decisions, loops, concurrency, failures and helpers. */
export const CONTROL_FLOW = `# Control flow

Write normal TypeScript. The diagram is derived from the code's structure, so structure the code the way you'd explain the process.

## Decisions

- \`if / else if / else\`, \`switch\`, \`?:\` and \`&&\`/\`||\` around steps become one decision with an arm per option.
- Label a decision with a comment on the line above: \`// How urgent is it?\`. Without one, the condition's code is the label. Labels are for people; write them as questions.
- Comparing a \`judge\` or \`ask\` answer (\`if (kind === "bug")\`, \`switch (choice)\`, \`answer.choice\` with fields) draws one arm per declared outcome.
- \`if (w.when("Any new issues?", issues.length > 0))\` labels a decision inline.

## Loops

| Shape | Use it for |
|---|---|
| \`for\`, \`for…of\`, \`while\` with steps inside | Sequential work. Label the loop with a comment. |
| \`w.each(label, items, { concurrency: 3 }, async (w, item, index) => …)\` | The same steps per item, several at once. Returns the callbacks' results in order. \`concurrency\` is a literal, 1–50. |
| \`w.repeat(label, { max: 5 }, async (w, attempt) => { …; return w.done(value) })\` | Try until it works: review loops, polling, fix rounds. Returns \`{ done, value?, attempts }\`; \`done\` is false when \`max\` ran out. |
| \`w.parallel(label, { mail: async (w) => …, calendar: async (w) => … })\` | Named branches at the same time. Returns \`{ mail, calendar }\`. |
| \`await Promise.all([w.a(…), w.b(…)])\` | A few steps at the same time. |

Inside \`each\`, \`repeat\` and \`parallel\` callbacks, use the receiver the callback gets (\`async (w, item) =>\`), not the outer one.

## Coordinating concurrent work in plain code

Workflow code is ordinary JavaScript, so you can coordinate with promises, \`Map\`s and closures. It replays deterministically: journaled steps settle in the order they originally finished.

\`\`\`ts
// Run every ticket at once, but each waits for its blockers to finish first.
const finish = new Map<number, (ok: boolean) => void>();
const finished = new Map<number, Promise<boolean>>();
for (const t of tickets) finished.set(t.number, new Promise((resolve) => finish.set(t.number, resolve)));

await w.each("Each ticket", tickets, { concurrency: 50 }, async (w, ticket) => {
  let ok = false;
  try {
    const blockers = await Promise.all(ticket.blockedBy.map((n) => finished.get(n) ?? Promise.resolve(true)));
    if (blockers.every(Boolean)) ok = await deliver(w, ticket);
  } finally {
    finish.get(ticket.number)!(ok);
  }
});
\`\`\`

A small semaphore (\`slots(3)\`, see \`examples/work-through-tickets.ts\`) caps how many run at once without blocking the ones still waiting on blockers.

## Failures

- A failed step throws. \`try { … } catch { … }\` around steps draws an "if it fails" path; an uncaught failure fails the run.
- \`http\`, \`call\`, \`judge\` and \`extract\` retry transient failures on their own. Don't wrap them in retry loops; use \`w.repeat\` for retrying a whole process (build → check → fix).
- \`return\` ends the run (or the current item/branch inside a callback) early.

## Helpers

\`async function triage(w, issue) { … }\` in the same file, called as \`await triage(w, issue)\`. Its steps show inline in the diagram wherever it's called. The receiver is always the first parameter. Recursion isn't allowed.

Top-level functions without steps are ordinary code. Ones passed to \`w.run\` (and helpers only they call) run in Node instead of the sandbox.

## What workflow code can't do

No \`fetch\`, timers, \`process\`, \`require\`, dynamic \`import()\`, \`eval\`, \`Intl\`, \`URL\`, \`Buffer\` or \`Blob\`: the validator says which step to use instead. \`console.log\` works and shows in the run's logs. \`URLSearchParams\`, \`TextEncoder\`/\`TextDecoder\`, \`atob\`/\`btoa\` and \`structuredClone\` work. Format dates and numbers by hand or inside \`w.run\`.
`;
