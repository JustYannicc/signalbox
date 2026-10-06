import { EVENTS_SECTION } from "./events.ts";

/** `references/triggers.md`: What starts a run: schedules, webhooks, events, other automations. */
export const TRIGGERS = `# Triggers

\`meta.triggers\` lists what starts a run. Every automation can also be run by hand (\`automation_run\`, or Run in the app) with any JSON \`input\`; it needs no trigger for that.

\`\`\`ts
export const meta = {
  name: "…",
  triggers: [
    { cron: "0 9 * * 1-5", timezone: "Europe/Zurich" },
    { webhook: true },
  ],
  overlap: "skip",          // cron: skip a tick while the last run is still going (default), or "allow"
  timeout: { hours: 6 },    // fail a run still going after this long; no limit by default
} as const;
\`\`\`

The workflow gets \`(w, input, trigger)\`. \`trigger.type\` is \`"manual"\`, \`"cron"\`, \`"webhook"\`, \`"event"\` or \`"automation"\`.

## Schedules

\`{ cron: "<five fields>", timezone? }\`. Always set \`timezone\` to the user's; without it the server's zone is used. Input is null. A tick missed by more than an hour (the server was down) is skipped, not run late.

## Webhooks

\`{ webhook: true }\` gives the automation a URL; every POST starts a run with the parsed JSON body as \`input\`. The third argument has \`trigger.headers\` and \`trigger.rawBody\`, for verifying a signature in a \`w.run\` function. Requests with the same \`Idempotency-Key\` or \`X-Request-Id\` within 24 hours start one run. The URL is on the automation's page; rotating it there stops the old one.

## Events in Signalbox

${EVENTS_SECTION}
## From another automation

\`await w.start("Start the report", "Weekly report", { week })\` starts another automation in the same project; its \`trigger.type\` is \`"automation"\`.
`;
