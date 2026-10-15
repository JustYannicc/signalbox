import { RuntimeMode } from "@t3tools/contracts";
import { runtimeModeWithin } from "@signalbox/automations/access";
import { WATCH_WAKE_LIMIT } from "@signalbox/automations/defaults/watchPullRequest";
import { HOOK_ROUTE_PREFIX } from "@signalbox/automations/views";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { resolveRuntimeMode } from "../mcp/OrchestratorMcpService.ts";
import { PULL_REQUEST_WATCH_WAKE_LIMIT } from "../orchestration-v2/pullRequestWatch.ts";
import { WEBHOOK_ROUTE_PREFIX } from "../scheduledTasks/ScheduledTaskService.ts";

// The engine package can't import the server, so it mirrors these upstream values.
describe("the engine's copies of upstream's rules", () => {
  it("hooks ride upstream's webhook route", () => {
    expect(HOOK_ROUTE_PREFIX).toBe(WEBHOOK_ROUTE_PREFIX);
  });

  it("the PR watch stops after as many comment-only wakes as upstream's", () => {
    expect(WATCH_WAKE_LIMIT).toBe(PULL_REQUEST_WATCH_WAKE_LIMIT);
  });

  it.effect("runtime modes rank like upstream's escalation check", () =>
    Effect.gen(function* () {
      for (const ceiling of RuntimeMode.literals) {
        for (const mode of RuntimeMode.literals) {
          const upstream = yield* Effect.exit(resolveRuntimeMode(ceiling, mode));
          expect(runtimeModeWithin(mode, ceiling), `${mode} within ${ceiling}`).toBe(
            Exit.isSuccess(upstream),
          );
        }
      }
    }),
  );
});
