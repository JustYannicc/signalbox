import type {
  AutomationError,
  AutomationRetryVersion,
  AutomationRunSummary,
  WorkflowStepVerb,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { AuthorizeAutomation } from "./catalog.ts";
import { automationDefaults } from "./columns.ts";
import type { LaunchRun } from "./engineTypes.ts";
import { fail } from "./errors.ts";
import { fromJson } from "./json.ts";
import type { AutomationRow, StepRow, WorkflowStore } from "./WorkflowStore.ts";

/**
 * Retrying a failed or cancelled run: a new run, linked to the original by
 * `retry_of_run_id`, whose first replay reuses the original's successful
 * steps. It replays with the original's seed and start time, so code between
 * steps computes what it computed the first time.
 */

/**
 * What a retry's first replay takes from the run it retries. Steps are reused
 * in the order the code reaches them while each one's key, verb and label
 * match a step that succeeded before. Keys are call-site ids, so on another
 * version an unchanged call can land on a different key; the first step that
 * doesn't match (a moved call, a new label, or the step that failed) ends
 * reuse for the rest of the run, so nothing after it runs on results from a
 * different path. Only the first replay inherits: anything reached later
 * waited on a step that ran fresh, so it runs fresh too.
 */
export function makeInheritance(original: ReadonlyArray<StepRow>, runId: string) {
  const byKey = new Map(original.map((step) => [step.step_key, step]));
  const reused = new Map<string, StepRow>();
  let open = true;
  return {
    /** The original's step to reuse for this call, copied into the retry; undefined runs it fresh. */
    take: (call: {
      readonly key: string;
      readonly verb: WorkflowStepVerb;
      readonly label: string;
    }): StepRow | undefined => {
      const taken = reused.get(call.key);
      if (taken || !open) return taken;
      const prior = byKey.get(call.key);
      if (prior?.status === "succeeded" && prior.verb === call.verb && prior.label === call.label) {
        const copy: StepRow = { ...prior, run_id: runId };
        reused.set(call.key, copy);
        return copy;
      }
      open = false;
      return undefined;
    },
    /** Every step reused so far, to journal in the retry. */
    reused: (): ReadonlyArray<StepRow> => [...reused.values()],
  };
}

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
