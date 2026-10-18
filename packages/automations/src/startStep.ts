import { parseAutomationAsk, type AutomationError } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { isBuiltinToolOperation, type BuiltinTools } from "./builtinTools/runner.ts";
import { sourceWatchProblem, waitForEventProblem } from "./compiler/eventTriggers.ts";
import { automationDefaults, stepArgs } from "./columns.ts";
import type { makeConnections } from "./connections.ts";
import type { EngineServices } from "./engineTypes.ts";
import { fail } from "./errors.ts";
import { isExternalRunSystem, type ExternalRuns } from "./external.ts";
import { asRecord, fromJson, toJson } from "./json.ts";
import { modelPrompt } from "./modelSteps.ts";
import type { AutomationFunctions, AutomationModelSteps, CallbackLink } from "./host.ts";
import { waitsOnEvents } from "./events/runWaits.ts";
import { eventCursorForRun } from "./events/cursor.ts";
import { explained } from "./runLog.ts";
import { runModelStep } from "./runModelStep.ts";
import { retryAfterMs, retryPolicy, stepTimeoutMs } from "./stepPolicy.ts";
import {
  httpRequest,
  isRetryableStatus,
  completionModelFor,
  launchAgent,
  wakeAt,
  type StepStart,
} from "./steps.ts";
import { nowIso } from "./time.ts";
import { startChild, type ChildStartDependencies } from "./startChild.ts";
import type { AutomationRow, StepRow, WorkflowStore } from "./WorkflowStore.ts";
import type { RunLinkStore } from "./runLinkStore.ts";

/**
 * Starts the real work behind a step the code just reached: everything that
 * happens outside the sandbox. The engine records what comes back.
 */

/** What a step may do instead of finishing: try again later, e.g. after a 503. */
export type StepOutcome =
  | StepStart
  | { readonly type: "retry"; readonly error: string; readonly retryAfterMs?: number | undefined };

export interface StartStepDependencies extends ChildStartDependencies {
  readonly store: WorkflowStore;
  readonly links: RunLinkStore;
  readonly services: Context.Context<EngineServices>;
  readonly functions: AutomationFunctions["Service"];
  readonly models: AutomationModelSteps["Service"] | undefined;
  /** `w.run` on another system's runners. */
  readonly external: Pick<ExternalRuns, "start">;
  readonly connections: Effect.Success<typeof makeConnections>;
  /** `signalbox.<tool>` calls. */
  readonly builtinTools: BuiltinTools;
  /** `w.hook`: a callback link for the run. */
  readonly callback: (runId: string) => Effect.Effect<CallbackLink, AutomationError>;
}

export const makeStartStep =
  (deps: StartStepDependencies) =>
  (automation: AutomationRow, step: StepRow): Effect.Effect<StepOutcome, AutomationError> => {
    const { store } = deps;
    const args = stepArgs(step);
    const first = args[0];
    const defaults = () => automationDefaults(automation);
    const thread = (prompt?: string) =>
      launchAgent({
        step,
        options: first,
        projectId: automation.project_id,
        defaults: defaults(),
        timeoutMs: stepTimeoutMs(step.verb, args),
        ...(prompt === undefined ? {} : { prompt, interactionMode: "plan" as const }),
      }).pipe(Effect.provideContext(deps.services));
    switch (step.verb) {
      case "agent":
        return thread();
      case "llm":
      case "judge":
      case "extract": {
        const verb = step.verb;
        const options = asRecord(first);
        const models = deps.models;
        if (models === undefined) return thread(modelPrompt(verb, step.label, options));
        return runModelStep({
          verb,
          label: step.label,
          options,
          complete: (prompt) =>
            completionModelFor(options, defaults(), automation.project_id).pipe(
              Effect.flatMap((modelSelection) =>
                models.complete({
                  projectId: automation.project_id,
                  modelSelection,
                  prompt,
                }),
              ),
            ),
        }).pipe(
          Effect.provideContext(deps.services),
          Effect.map((value): StepOutcome => ({ type: "done", value })),
        );
      }
      case "http":
        return Effect.gen(function* () {
          const value = yield* httpRequest(first, {
            idempotencyKey: `${step.run_id}/${step.step_key}`,
            timeoutMs: stepTimeoutMs("http", args) ?? 60_000,
          });
          const retryable =
            isRetryableStatus(value.status) && step.attempt < retryPolicy("http", args).attempts;
          if (!retryable) return { type: "done", value } satisfies StepOutcome;
          const now = yield* DateTime.now;
          return {
            type: "retry",
            error: `${String(asRecord(first).url ?? first)} answered ${value.status}.`,
            retryAfterMs: retryAfterMs(value.headers["retry-after"], now.epochMilliseconds),
          } satisfies StepOutcome;
        }).pipe(Effect.provideContext(deps.services));
      case "sleep":
        return wakeAt(first).pipe(
          Effect.map((at): StepOutcome => ({ type: "waiting", wakeAt: at })),
        );
      case "eventCursor":
        return deps.links
          .captureEventCursor(step.run_id)
          .pipe(Effect.map((value): StepOutcome => ({ type: "done", value })));
      case "waitFor": {
        const { event, timeout, on, watch, after } = asRecord(first);
        // `on` steps wait without a name; runWaits.ts hands them matching events.
        const named = typeof event === "string" ? { event } : {};
        if (after !== undefined && named.event)
          return fail("w.waitFor `after` only works with `on` or `watch` events.");
        if (!waitsOnEvents(step) && !named.event)
          return fail("w.waitFor needs `on`, `watch` or an event name.");
        // A computed `on` or `watch` skipped the compiler's check.
        const problem =
          (on === undefined ? null : waitForEventProblem(on, watch !== undefined)) ??
          (watch === undefined ? null : sourceWatchProblem(watch, on));
        if (problem) return Effect.fail(explained(problem.message, { fix: problem.hint }));
        return Effect.gen(function* () {
          if (after !== undefined) yield* eventCursorForRun(after, step.run_id);
          const at = timeout === undefined ? undefined : yield* wakeAt(timeout);
          return { type: "waiting", ...named, ...(at ? { wakeAt: at } : {}) } satisfies StepStart;
        });
      }
      case "ask": {
        const { problems } = parseAutomationAsk(first);
        if (problems.length > 0) {
          return Effect.fail(
            explained(`This question can't be answered: ${problems.join(" ")}`, {
              fix: 'Give w.ask options as a list of strings and each field a type, e.g. { fields: { reply: { type: "longText" } } }.',
            }),
          );
        }
        const timeout = asRecord(first).timeout;
        return timeout === undefined
          ? Effect.succeed({ type: "waiting" })
          : wakeAt(timeout).pipe(
              Effect.map((at): StepOutcome => ({ type: "waiting", wakeAt: at })),
            );
      }
      case "hook":
        return deps
          .callback(step.run_id)
          .pipe(Effect.map((value): StepOutcome => ({ type: "done", value })));
      case "recall":
        return store.recall(automation.automation_id, String(first)).pipe(
          Effect.map((value): StepOutcome => ({
            type: "done",
            value: value === undefined ? null : fromJson(value),
          })),
        );
      case "remember":
        return Effect.gen(function* () {
          yield* store.remember(
            automation.automation_id,
            String(first),
            toJson(args[1] ?? null),
            yield* nowIso,
          );
          return { type: "done", value: null } as const;
        });
      case "notify":
        // Clients show finished notify steps; there's nothing more to do here.
        return Effect.succeed({ type: "done", value: null });
      case "start":
        return startChild(
          deps,
          automation,
          step,
          String(first),
          args[1],
          asRecord(args[2]).wait !== false,
        );
      case "call": {
        const options = asRecord(args[2]);
        if (isBuiltinToolOperation(String(first))) {
          return deps.builtinTools
            .call(String(first), {
              args: args[1] ?? {},
              automationId: automation.automation_id,
              projectId: automation.project_id,
              runId: step.run_id,
              automationName: automation.name,
              runtimeMode: defaults().runtimeMode,
              requestKey: `${step.run_id}/${step.step_key}`,
            })
            .pipe(Effect.map((value): StepOutcome => ({ type: "done", value })));
        }
        return deps.connections
          .call({
            operation: String(first),
            args: args[1] ?? {},
            connection: typeof options.connection === "string" ? options.connection : undefined,
            // Executor's approvals guard calls the automation's owner didn't allow everything for.
            autoApprove: defaults().runtimeMode === "full-access",
            idempotencyKey: `${step.run_id}/${step.step_key}`,
          })
          .pipe(Effect.map((value): StepOutcome => ({ type: "done", value })));
      }
      case "run":
        return Effect.gen(function* () {
          if (defaults().runtimeMode !== "full-access") {
            return yield* explained(
              "w.run runs code on the server, so it needs an automation saved from a full-access thread.",
              { fix: "Save the automation again from a thread in full-access mode." },
            );
          }
          const run = yield* store.getRun(step.run_id);
          const version = run ? yield* store.getVersion(run.automation_id, run.version) : undefined;
          // `w.run(label, { on }, fn, …args)` sends the function to another system's runner.
          const options = typeof first === "object" && first !== null ? asRecord(first) : null;
          if (options) {
            if (!isExternalRunSystem(options.on))
              return yield* fail(`w.run can't run on ${String(options.on)}.`);
            return yield* deps.external.start(automation, step, {
              on: options.on,
              options,
              module: version?.run_module ?? null,
              name: String(args[1]),
              args: args.slice(2),
            });
          }
          const value = yield* deps.functions.run({
            automationId: automation.automation_id,
            projectId: automation.project_id,
            version: run?.version ?? automation.version,
            module: version?.run_module ?? null,
            name: String(first),
            args: args.slice(1),
            resultName: `${step.run_id}-${step.step_key}`,
          });
          return { type: "done", value } satisfies StepStart;
        });
    }
  };

export type StartStep = ReturnType<typeof makeStartStep>;
