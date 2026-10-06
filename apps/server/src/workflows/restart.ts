import type { AutomationError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EndRun, LaunchRun } from "./engineTypes.ts";
import { logFailure } from "./errors.ts";
import type { RunLinkStore } from "./runLinkStore.ts";
import { isoAt } from "./time.ts";
import type { AutomationRow, RunRow, WorkflowStore } from "./WorkflowStore.ts";

/**
 * `return w.restart(input)`: continue-as-new. The run succeeds and a fresh
 * run of the same automation starts on its live version with `input` and an
 * empty journal, so long-lived loops (watching a pull request for days) don't
 * replay an ever-growing history. The new run keeps the old one's trigger,
 * parent, start depth and thread attachment; restarting doesn't count toward
 * the `w.start` depth limit.
 */

/** Restarts per chain per hour before the chain fails; a loop with no wait between passes hits it. */
export const MAX_RESTARTS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

export interface RestartDependencies {
  readonly store: WorkflowStore;
  readonly links: RunLinkStore;
  readonly newId: (prefix: string) => Effect.Effect<string, AutomationError>;
  readonly endRun: EndRun;
  readonly launchRun: LaunchRun;
}

export const makeRestart =
  (deps: RestartDependencies) =>
  (run: RunRow, automation: AutomationRow, input: unknown): Effect.Effect<void, AutomationError> =>
    Effect.gen(function* () {
      const link = yield* deps.links.getLink(run.run_id);
      const lineage = link?.lineage_id ?? run.run_id;
      const now = yield* DateTime.now;
      const recent = yield* deps.links.restartsSince(
        lineage,
        isoAt(now.epochMilliseconds - HOUR_MS),
      );
      if (recent >= MAX_RESTARTS_PER_HOUR) {
        yield* deps.endRun(run, {
          status: "failed",
          error: `The automation restarted ${MAX_RESTARTS_PER_HOUR} times within an hour.`,
          detail: {
            why: "w.restart ran again and again without waiting in between, which looks like a loop.",
            fix: "Wait for something (w.waitFor, w.sleep) before returning w.restart, or restart less often.",
            link: null,
          },
        });
        return;
      }
      const runId = yield* deps.newId("run");
      const ended = yield* deps.endRun(run, {
        status: "succeeded",
        output: { restartedAs: runId },
      });
      if (!ended) return;
      const parent = run.parent_run_id ? yield* deps.store.getRun(run.parent_run_id) : undefined;
      yield* deps
        .launchRun({
          automation,
          input,
          trigger: run.trigger,
          runId,
          ...(parent ? { parent } : { depth: run.depth }),
          ...(run.trigger_json === null ? {} : { triggerJson: run.trigger_json }),
          link: {
            thread_id: link?.thread_id ?? null,
            attach_key: link?.attach_key ?? null,
            label: link?.label ?? null,
            restart_of_run_id: run.run_id,
            lineage_id: lineage,
          },
        })
        .pipe(logFailure("Automation restart couldn't start the next run", { runId: run.run_id }));
    });
