import { defineEvlog, type DrainContext } from "evlog";
import { createDrainPipeline } from "evlog/pipeline";
import { createPostHogDrain } from "evlog/posthog";
import { createSentryDrain } from "evlog/sentry";

import { redactContent } from "./src/observability/content.ts";
import { postHogEnabled } from "./src/observability/posthog.ts";

/**
 * evlog for Signalbox Cloud (#285): one wide event per request, turn, Durable
 * Object alarm, and pool or Executor call. Both Workers bundle this file and
 * read it at module scope, where `process.env` holds the Worker's vars
 * (`nodejs_compat`). The deploy passes them (`alchemy.run.ts`):
 *
 * - `SENTRY_DSN`: wide events as Sentry logs, and errors as Sentry issues.
 * - `POSTHOG_API_KEY` and `POSTHOG_HOST`: wide events as PostHog logs. Both
 *   are required: there is no default host, since Signalbox's PostHog is to be
 *   an EU project (#358) and evlog's default is US. Also requires
 *   `SIGNALBOX_POSTHOG_ENABLED=true` after #358 lands. Off with
 *   `T3CODE_TELEMETRY_ENABLED=false`, the self-hosted server's switch.
 * - `SIGNALBOX_STAGE`: the event's environment. evlog reads `APP_VERSION`
 *   (the release) itself.
 *
 * A drain without its key is left out, so local dev and tests drain nowhere.
 */

const analyticsEnabled = postHogEnabled({
  SIGNALBOX_POSTHOG_ENABLED: process.env.SIGNALBOX_POSTHOG_ENABLED,
  T3CODE_TELEMETRY_ENABLED: process.env.T3CODE_TELEMETRY_ENABLED,
});

const drains = [
  process.env.SENTRY_DSN ? createSentryDrain({ issues: true }) : null,
  process.env.POSTHOG_API_KEY && process.env.POSTHOG_HOST && analyticsEnabled
    ? createPostHogDrain({ host: process.env.POSTHOG_HOST })
    : null,
].filter((drain) => drain !== null);

// Batched per isolate; each unit hands the batch's send to `waitUntil`.
const pipeline = createDrainPipeline<DrainContext>({ batch: { size: 50, intervalMs: 1000 } });

export const drain =
  drains.length === 0
    ? undefined
    : pipeline(async (batch) => {
        await Promise.allSettled(drains.map((send) => send(batch)));
      });

export default defineEvlog({
  service: "signalbox-cloud",
  environment: process.env.SIGNALBOX_STAGE || "development",
  // The built-ins (tokens, secrets, emails…), then anything content-shaped.
  redact: { transform: redactContent },
  // The web app's own files are no unit of work.
  exclude: ["/assets/**"],
  // Everything is kept for now. Once info is sampled, failures and slow work still are.
  sampling: { keep: [{ status: 400 }, { duration: 1000 }] },
  ...(drain !== undefined && { drain }),
});
