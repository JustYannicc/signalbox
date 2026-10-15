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
## Changes in a connected source

Anything an Executor operation lists can be watched: a GitHub Actions run list, Stripe invoices, a Linear project's issues, a sheet's rows. Add \`watch\` to a \`source.item.*\` trigger:

\`\`\`ts
triggers: [{
  on: "source.item.added",          // or source.item.changed, source.item.removed, source.item.*
  watch: {
    operation: "github.actions.listWorkflowRunsForRepo", // as w.call names it
    args: { owner: "acme", repo: "app", branch: "main" },
    key: "id",                      // what identifies an item; a dotted path reaches in
    items: "workflow_runs",         // where the list is; optional when the answer is a list or has one list
    fields: ["status", "conclusion"], // optional: only these count for source.item.changed
    every: { minutes: 2 },          // optional, default 5 minutes, at least 1
    connection: "work",             // optional, when the service is connected more than once
  },
}]
\`\`\`

The run's input is the event: \`item\` as the operation returns it, its \`key\`, and for \`source.item.changed\` the item \`before\` and the top-level fields that \`changed\`. Signalbox reads each source once for everyone watching it (automations and waiting runs alike), so don't keep your own list of seen ids for it. The first read only records what's there; a restart picks up where it left off. A quiet source is read less often; one that fails backs off, and after 5 failures in a row it stops and the owner is told; saving the automation again retries. \`source.item.removed\` means the operation stopped listing it, which for a paged list can also mean it scrolled off. \`automation_read\` shows each watched source's \`watching\` status and when it was last checked.

## From another automation

\`await w.start("Start the report", "Weekly report", { week })\` starts another automation in the same project; its \`trigger.type\` is \`"automation"\`.
`;
