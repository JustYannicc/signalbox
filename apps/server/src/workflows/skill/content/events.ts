import { AUTOMATION_EVENTS, AUTOMATION_EVENT_ENVELOPE } from "@t3tools/contracts";

const describeFields = (fields: Readonly<Record<string, string>>) =>
  Object.entries(fields)
    .map(([field, doc]) => (doc ? `\`${field}\` (${doc.replaceAll("|", "\\|")})` : `\`${field}\``))
    .join(", ");

/** The event catalog as a table, from the same list the engine and compiler use. */
const EVENT_TABLE = [
  "| Event | When | Fields |",
  "|---|---|---|",
  ...AUTOMATION_EVENTS.map(
    (spec) => `| \`${spec.name}\` | ${spec.description} | ${describeFields(spec.fields)} |`,
  ),
].join("\n");

/** The "Events in Signalbox" part of `references/triggers.md`. */
export const EVENTS_SECTION = `\`{ on: "turn.finished" }\` starts a run every time that happens in any thread of this project, with whatever provider ran it. The run's \`input\` is the event: \`{ ${Object.keys(AUTOMATION_EVENT_ENVELOPE).join(", ")}, …fields }\`.

- \`on\`: an event name, a list, or a wildcard (\`"turn.*"\`, \`"*"\`). Every internal orchestration event is also available raw as \`"orchestration.<type>"\`, payload under \`data\`.
- \`scope: "all"\`: every project, not just this one.
- \`from: "people" | "agents" | "anyone"\`: who caused it, for \`message.sent\` and \`thread.created\`. Defaults to people.
- \`where: { status: "failed" }\`: top-level fields that must match; an array means any of them. Anything fancier: check in code and \`return\` early.
- Threads automations started never trigger unless \`includeAutomationThreads: true\`, and an automation never triggers on its own runs, so it can't feed itself.
- More than \`maxRunsPerMinute\` (default 30) event runs in a minute pauses the automation's event triggers and tells the user.
- Every event starts its own run unless \`overlap: "skip"\` is set. \`trigger.event\` is the event's name and \`trigger.eventId\` its id; one occurrence never starts the same automation twice.

${EVENT_TABLE}

Pull request events come from the pull requests linked to a thread, as Signalbox syncs them from the host: \`pr.updated\` on every sync, and \`pr.merged\`, \`pr.closed\`, \`pr.checks.passed\`, \`pr.checks.failed\`, \`pr.conflicted\` when that becomes true, with the pull request's facts at the top level so \`where: { number: 12 }\` works. Comments and reviews aren't events; read them with \`gh\` in a \`w.run\` function.

\`\`\`ts
export const meta = {
  name: "Explain failed turns",
  intent: "when an agent's turn fails, tell me why if it's something I need to fix",
  triggers: [{ on: "turn.finished", where: { status: "failed" } }],
} as const;

export default workflow(async (w, turn: { threadTitle: string; error: string | null; lastMessage: string | null }) => {
  const verdict = await w.judge("Does someone need to act?", {
    input: turn,
    outcomes: ["act", "ignore"],
    question: "Is this failure something a person has to fix, rather than a flaky retry?",
  });
  if (verdict === "ignore") return;
  await w.notify("Tell me what broke", \`"\${turn.threadTitle}" failed: \${turn.error ?? "no reason given"}\`);
});
\`\`\`
`;
