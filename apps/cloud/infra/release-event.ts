// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a CI script; its output is the job log.
/**
 * One wide event per deploy (#285), sent by `deploy-cloud.yml` after
 * `alchemy deploy`: the stage now runs `APP_VERSION`. It goes through the
 * Workers' own drains (`evlog.config.ts`), so Sentry and PostHog can line up
 * a release's errors and events with when it shipped. Run from apps/cloud:
 *
 *   node infra/release-event.ts
 *
 * Reads `SIGNALBOX_STAGE`, `APP_VERSION`, the drain keys, and GitHub's own
 * `GITHUB_*` variables. Without any drain key it only prints the event.
 */
import { toLoggerConfig, toMiddlewareOptions } from "evlog";
import { initLoggerLayer, withLogger } from "evlog/effect";
import * as Effect from "effect/Effect";
import * as NodeProcess from "node:process";

import config from "../evlog.config.ts";

const env = NodeProcess.env;
const stage = env.SIGNALBOX_STAGE ?? "";
const release = env.APP_VERSION ?? "";
if (stage === "" || release === "") {
  console.error("SIGNALBOX_STAGE and APP_VERSION are required.");
  NodeProcess.exit(1);
}

const run =
  env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;

await Effect.runPromise(
  Effect.void.pipe(
    withLogger("release", {
      ...toMiddlewareOptions(config),
      fields: {
        release: { version: release, stage, ...(run !== undefined && { run }) },
        ...(env.PR_NUMBER && { pullRequest: Number(env.PR_NUMBER) }),
      },
    }),
    // Flushes the batched drains before the script exits.
    Effect.provide(initLoggerLayer({ ...toLoggerConfig(config), pretty: false })),
  ),
);
