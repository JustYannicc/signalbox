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

The workflow gets \`(w, input, trigger)\`. \`trigger.type\` is \`"manual"\`, \`"cron"\`, \`"webhook"\`, \`"event"\` or \`"automation"\`. A run started attached to a thread also has \`trigger.attach: { threadId, key, label }\` (see \`patterns.md\`).

## Schedules

\`{ cron: "<five fields>", timezone? }\`. Always set \`timezone\` to the user's; without it the server's zone is used. Input is null. A tick missed by more than an hour (the server was down) is skipped, not run late.

## Webhooks

\`{ webhook: true }\` gives the automation a URL (\`webhook.url\` in \`automation_read\`, public when Signalbox Connect is linked); every request to it starts a run with the body as \`input\` (parsed JSON or form, else text, null when empty). The third argument has \`trigger.method\`, \`trigger.headers\` and \`trigger.query\` (credential-looking ones redacted) and \`trigger.rawBody\`. Requests with the same \`Idempotency-Key\` or \`X-Request-Id\` within 24 hours start one run. Rotating the URL on the automation's page stops the old one.

For a sender that signs requests, let the server check them instead of doing it in code:

\`\`\`ts
triggers: [{ webhook: {
  signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" }, // GitHub
  maxDeliveryAgeMinutes: 60, // optional: skip requests held longer while the server was offline
} }]
\`\`\`

The secret never goes in the file: ask the user with \`request_secret\` and pass the \`secretRef\` to \`automation_set_webhook_secret\`. Until it's set, every request is turned away. Requests turned away (bad signature, paused, over 60 a minute, too old) show in \`automation_read\` as \`webhookRejections\`.

## Events in Signalbox

${EVENTS_SECTION}
## From another automation

\`await w.start("Start the report", "Weekly report", { week })\` starts another automation in the same project; its \`trigger.type\` is \`"automation"\`.
`;
