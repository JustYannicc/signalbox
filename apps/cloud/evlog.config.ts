import { defineEvlog, type DrainContext } from "evlog";
import { createDrainPipeline } from "evlog/pipeline";
import { createPostHogDrain } from "evlog/posthog";
import { createSentryDrain } from "evlog/sentry";

import { redactContent } from "./src/observability/content.ts";

/**
 * evlog for Signalbox Cloud (#285): one wide event per request, turn, Durable
 * Object alarm, and pool or Executor call. Both Workers bundle this file and
 * read it at module scope, where `process.env` holds the Worker's vars
 * (`nodejs_compat`). The deploy passes them (`alchemy.run.ts`):
 *
 * - `SENTRY_DSN`: wide events as Sentry logs, and errors as Sentry issues.
 * - `POSTHOG_API_KEY`, `POSTHOG_HOST`: wide events as PostHog logs. Off with
 *   `T3CODE_TELEMETRY_ENABLED=false`, the self-hosted server's switch.
 * - `SIGNALBOX_STAGE`: the event's environment. evlog reads `APP_VERSION`
 *   (the release) itself.
 *
 * A drain without its key is left out, so local dev and tests drain nowhere.
 */

const telemetryOff = ["false", "no", "off", "0", "n"].includes(
  process.env.T3CODE_TELEMETRY_ENABLED?.trim().toLowerCase() ?? "",
);

const drains = [
  process.env.SENTRY_DSN ? createSentryDrain({ issues: true }) : null,
  process.env.POSTHOG_API_KEY && !telemetryOff ? createPostHogDrain() : null,
].filter((drain) => drain !== null);

// Batched per isolate; each unit hands the batch's send to `waitUntil`.
const pipeline = createDrainPipeline<DrainContext>({ batch: { size: 50, intervalMs: 1000 } });

export default defineEvlog({
  service: "signalbox-cloud",
  environment: process.env.SIGNALBOX_STAGE || "development",
  // The built-ins (tokens, secrets, emails…), then anything content-shaped.
  redact: { transform: redactContent },
  // The web app's own files are no unit of work.
  exclude: ["/assets/**"],
  // Everything is kept for now. Once info is sampled, failures and slow work still are.
  sampling: { keep: [{ status: 400 }, { duration: 1000 }] },
  ...(drains.length > 0 && {
    drain: pipeline(async (batch) => {
      await Promise.allSettled(drains.map((drain) => drain(batch)));
    }),
  }),
});
