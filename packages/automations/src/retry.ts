import type {
  AutomationError,
  AutomationRetryVersion,
  AutomationRunSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { AuthorizeAutomation } from "./catalog.ts";
import { automationDefaults } from "./columns.ts";
import type { LaunchRun } from "./engineTypes.ts";
import { fail } from "./errors.ts";
import { fromJson } from "./json.ts";
import type { AutomationRow, WorkflowStore } from "./WorkflowStore.ts";

/** A fresh run linked to the failed or cancelled run it retries. */
export type RetryRun = <E = never>(input: {
  readonly runId: string;
  /** `same` (the default) replays the run's own version; `latest` the live one, e.g. after a fix. */
  readonly version?: AutomationRetryVersion | undefined;
  readonly authorize?: AuthorizeAutomation<E>;
}) => Effect.Effect<AutomationRunSummary, AutomationError | E>;

export const makeRetryRun =
  (deps: {
    readonly store: WorkflowStore;
    readonly requireAutomation: (
      automationId: string,
    ) => Effect.Effect<AutomationRow, AutomationError>;
    readonly launchRun: LaunchRun;
  }): RetryRun =>
  (input) =>
    Effect.gen(function* () {
      const { store } = deps;
      const runId = input.runId;
      const original = yield* store.getRun(runId);
      if (!original) return yield* fail("That run doesn't exist.", { runId });
      if (original.status !== "failed" && original.status !== "cancelled")
        return yield* fail("Only a failed or cancelled run can be retried.", { runId });
      const automation = yield* deps.requireAutomation(original.automation_id);
      if (input.authorize) yield* input.authorize(automationDefaults(automation));
      const version = input.version === "latest" ? automation.version : original.version;
      if ((yield* store.getVersionScript(automation.automation_id, version)) === undefined) {
        return yield* fail("The version this run used is gone. Retry it on the latest version.", {
          runId,
        });
      }
      const started = yield* deps.launchRun({
        automation,
        input: fromJson(original.input_json),
        trigger: original.trigger,
        retryOf: original,
        version,
      });
      return started.run;
    });
