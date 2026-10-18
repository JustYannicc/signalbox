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

The workflow gets \`(w, input, trigger)\`. \`trigger.type\` is \`"manual"\`, \`"cron"\`, \`"webhook"\`, \`"event"\` or \`"automation"\`. \`trigger.at\` is when the run started, as an ISO string; it stays the same on every replay, so use it instead of \`Date.now()\`. A run started attached to a thread also has \`trigger.attach: { threadId, key, label }\` (see \`patterns.md\`).

## Schedules

\`{ cron: "<five fields>", timezone? }\`. Always set \`timezone\` to the user's; without it the server's zone is used. Input is null. A tick missed by more than an hour (the server was down) is skipped, not run late.

## Webhooks

\`{ webhook: true }\` gives the automation a URL (\`webhook.url\` in \`automation_read\`, public in Signalbox Cloud); every request to it starts a run with the body as \`input\` (parsed JSON or form, else text, null when empty). The third argument has \`trigger.method\`, \`trigger.headers\` and \`trigger.query\` (credential-looking ones redacted) and \`trigger.rawBody\`. Requests with the same \`X-GitHub-Delivery\` in the cloud, or \`Idempotency-Key\` or \`X-Request-Id\` within 24 hours start one run. Rotating the URL on the automation's page stops the old one.

For a sender that signs requests, let the server check them instead of doing it in code:

\`\`\`ts
triggers: [{ webhook: {
  signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" }, // GitHub
  maxDeliveryAgeMinutes: 60, // optional: skip requests held longer while the server was offline
} }]
\`\`\`

The secret never goes in the file: ask the user with \`request_secret\` and pass the \`secretRef\` to \`automation_set_webhook_secret\`. Until it's set, every request is turned away. Requests turned away (bad signature, paused, over 60 a minute, too old) show in \`automation_read\` as \`webhookRejections\`.

## GitHub events in the cloud

Connect GitHub in Settings. Triggers for \`pr.*\`, \`release.published\` and \`issue.opened\` install repository hooks automatically. Set \`where: { repository: "owner/repo" }\` to choose a repository; otherwise the folder's repository is used. The connected account needs permission to manage its hooks. Read \`automation_github_subscriptions\` for setup errors and the active mode. Pausing or deleting the last matching automation removes its hook.

An upstream repository that refuses hook access can supply published releases by polling every five minutes. Its first read records existing releases without starting historical runs. Linked PRs retain their existing watcher; a repository without hook permission does not supply arbitrary PR-opened events.

PR events include current state, mergeability, checks, review decision, unresolved thread count, head/base branches and SHAs, repositories, labels and recent reviews. Incomplete lists are null. Completed checks for an older head are ignored. Use \`pull_request_read\` in a step to refresh facts before acting.

## Events in Signalbox

${EVENTS_SECTION}
## Changes in a connected source

Connected-service \`watch\` and \`source.item.*\` triggers are unavailable in cloud automations. Use a service webhook to start a run, or a cron trigger with \`w.http\` and keep a cursor with \`w.recall\` / \`w.remember\`. GitHub repository events use the integration above.

## From another automation

\`const report = await w.start("Weekly report", { week })\` runs another automation and returns its output; its \`trigger.type\` is \`"automation"\`. Names resolve in this folder, then its parents, then built-ins. Pass \`{ wait: false }\` as the third argument to continue without waiting.

Declare optional \`meta.input\` and \`meta.output\` Effect Schemas to check values at start and return. Import \`* as Schema from "effect/Schema"\` and use, for example, \`input: Schema.Struct({ week: Schema.Number })\`. Undeclared contracts accept and return unknown values.
`;
