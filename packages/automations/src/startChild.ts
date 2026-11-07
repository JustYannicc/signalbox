import type { AutomationError, AutomationRunSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { runtimeModeWithin } from "./access.ts";
import { preferSavedBlock } from "./blockResolution.ts";
import { childSettlement } from "./childRuns.ts";
import { automationDefaults } from "./columns.ts";
import { fail } from "./errors.ts";
import { explained } from "./runLog.ts";
import { MAX_START_DEPTH } from "./runLimits.ts";
import type { StepStart } from "./steps.ts";
import type { AutomationRow, RunRow, StepRow, WorkflowStore } from "./WorkflowStore.ts";

export interface ChildStartDependencies {
  readonly store: WorkflowStore;
  readonly projects: (projectId: string) => Effect.Effect<ReadonlyArray<string>, AutomationError>;
  readonly existingChild: (
    step: StepRow,
  ) => Effect.Effect<
    { readonly runId: string; readonly run: RunRow | undefined } | undefined,
    AutomationError
  >;
  /** `w.start` by a built-in's name, when the project has no automation of that name. */
  readonly resolveBuiltIn: (
    name: string,
    automation: AutomationRow,
  ) => Effect.Effect<AutomationRow | undefined, AutomationError>;
  /** Starts a run of `automation` as the child of `parent`. */
  readonly launchChild: (input: {
    readonly automation: AutomationRow;
    readonly input: unknown;
    readonly parent: RunRow;
    readonly step: StepRow;
    readonly wait: boolean;
  }) => Effect.Effect<AutomationRunSummary, AutomationError>;
}

/**
 * `w.start`: resolves a block on the folder chain. It must be on, may
 * not run with more access than this one, and chains stop at MAX_START_DEPTH.
 */
export const startChild = (
  deps: ChildStartDependencies,
  automation: AutomationRow,
  step: StepRow,
  name: string,
  input: unknown,
  wait: boolean,
) =>
  Effect.gen(function* () {
    const parent = yield* deps.store.getRun(step.run_id);
    if (!parent) return yield* fail("This run is gone.");
    const existing = yield* deps.existingChild(step);
    if (existing) return yield* childStart(existing.runId, existing.run, wait);
    if (parent.depth >= MAX_START_DEPTH) {
      return yield* explained(
        `w.start is nested ${MAX_START_DEPTH} automations deep; an automation is probably starting itself in a loop.`,
        { fix: "Make sure the automations started with w.start don't start their starter again." },
      );
    }
    let target: AutomationRow | undefined;
    for (const projectId of yield* deps.projects(automation.project_id)) {
      const candidate = yield* deps.store.getAutomationByName(projectId, name);
      target = preferSavedBlock(target, candidate);
      if (target !== undefined) break;
    }
    target ??= yield* deps.resolveBuiltIn(name, automation);
    if (!target) {
      return yield* explained(
        `There's no automation named "${name}" in this folder or its parents.`,
        {
          fix: "Use the exact meta.name of a saved automation or built-in.",
        },
      );
    }
    if (target.enabled !== 1) {
      return yield* explained(`"${name}" is paused, so it can't be started.`, {
        fix: `Turn "${name}" back on, or run it by hand.`,
      });
    }
    const own = automationDefaults(automation).runtimeMode;
    const theirs = automationDefaults(target).runtimeMode;
    if (!runtimeModeWithin(theirs, own)) {
      return yield* explained(
        `"${name}" runs with ${theirs} access, more than this automation's ${own}, so it can't start it.`,
        {
          why: "An automation may only start automations that run with at most its own access.",
          fix: `Save this automation from a thread with ${theirs} access, or save "${name}" from a more limited one.`,
        },
      );
    }
    const run = yield* deps.launchChild({ automation: target, input, parent, step, wait });
    if (!wait) return { type: "done", value: { runId: run.id } } satisfies StepStart;
    const child = yield* deps.existingChild(step);
    return yield* childStart(child?.runId ?? run.id, child?.run, wait);
  });

const childStart = (runId: string, child: RunRow | undefined, wait: boolean) =>
  Effect.gen(function* () {
    if (!wait) return { type: "done", value: { runId } } satisfies StepStart;
    if (!child) return { type: "waiting" } satisfies StepStart;
    const settled = childSettlement(child);
    if (settled?.ok) return { type: "done", value: settled.value } satisfies StepStart;
    if (settled)
      return yield* explained(settled.error, {
        ...(settled.detail?.why ? { why: settled.detail.why } : {}),
        ...(settled.detail?.fix ? { fix: settled.detail.fix } : {}),
        ...(settled.detail?.link ? { link: settled.detail.link } : {}),
      });
    return { type: "waiting" } satisfies StepStart;
  });
