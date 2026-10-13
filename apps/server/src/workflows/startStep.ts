import {
  parseAutomationAsk,
  ProjectId,
  type AutomationError,
  type AutomationRunSummary,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpClient from "effect/http/HttpClient";

import { resolveRuntimeMode } from "../mcp/OrchestratorMcpService.ts";
import type { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { ProjectService } from "../project/ProjectService.ts";
import { isBuiltinToolOperation, type BuiltinTools } from "./builtinTools/runner.ts";
import { automationDefaults, stepArgs } from "./columns.ts";
import type { makeConnections } from "./connections.ts";
import { automationError, fail } from "./errors.ts";
import { asRecord, fromJson, toJson } from "./json.ts";
import { modelPrompt } from "./modelSteps.ts";
import type { makeRunFunction } from "./runFunction.ts";
import { waitsOnEvents } from "./events/runWaits.ts";
import { explained } from "./runLog.ts";
import { retryAfterMs, retryPolicy, stepTimeoutMs } from "./stepPolicy.ts";
import { httpRequest, isRetryableStatus, launchAgent, wakeAt, type StepStart } from "./steps.ts";
import { nowIso } from "./time.ts";
import type { AutomationRow, RunRow, StepRow, WorkflowStore } from "./WorkflowStore.ts";

/**
 * Starts the real work behind a step the code just reached: everything that
 * happens outside the sandbox. The engine records what comes back.
 */

/** `w.start` chains this deep at most, so an automation starting itself can't run away. */
export const MAX_START_DEPTH = 5;

/** What a step may do instead of finishing: try again later, e.g. after a 503. */
export type StepOutcome =
  | StepStart
  | { readonly type: "retry"; readonly error: string; readonly retryAfterMs?: number | undefined };

export interface StartStepDependencies {
  readonly store: WorkflowStore;
  readonly services: Context.Context<
    ThreadLaunchService | ThreadManagementService | HttpClient.HttpClient
  >;
  readonly projects: ProjectService["Service"];
  readonly runFunction: Effect.Success<typeof makeRunFunction>;
  readonly connections: Effect.Success<typeof makeConnections>;
  /** `signalbox.<tool>` calls. */
  readonly builtinTools: BuiltinTools;
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
  }) => Effect.Effect<AutomationRunSummary, AutomationError>;
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
      case "extract":
        return thread(modelPrompt(step.verb, step.label, asRecord(first)));
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
      case "waitFor": {
        const { event, timeout } = asRecord(first);
        // `on` steps wait without a name; runWaits.ts hands them matching events.
        const named = typeof event === "string" ? { event } : {};
        if (!waitsOnEvents(step) && !named.event)
          return fail("w.waitFor needs `on` or an event name.");
        return Effect.gen(function* () {
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
        return startChild(deps, automation, step, String(first), args[1]);
      case "call": {
        const options = asRecord(args[2]);
        if (isBuiltinToolOperation(String(first))) {
          return deps.builtinTools
            .call(String(first), {
              args: args[1] ?? {},
              automationId: automation.automation_id,
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
          const project = yield* deps.projects
            .getById(ProjectId.make(automation.project_id))
            .pipe(
              Effect.mapError((cause) => automationError("Couldn't read the project.", { cause })),
            );
          if (Option.isNone(project)) return yield* fail("This automation's project is gone.");
          const value = yield* deps.runFunction.run({
            automationId: automation.automation_id,
            version: run?.version ?? automation.version,
            module: version?.run_module ?? null,
            name: String(first),
            args: args.slice(1),
            cwd: project.value.workspaceRoot,
            resultName: `${step.run_id}-${step.step_key}`,
          });
          return { type: "done", value } satisfies StepStart;
        });
    }
  };

/**
 * `w.start`: runs another automation of the same project. It must be on, may
 * not run with more access than this one, and chains stop at MAX_START_DEPTH.
 */
const startChild = (
  deps: StartStepDependencies,
  automation: AutomationRow,
  step: StepRow,
  name: string,
  input: unknown,
) =>
  Effect.gen(function* () {
    const parent = yield* deps.store.getRun(step.run_id);
    if (!parent) return yield* fail("This run is gone.");
    if (parent.depth >= MAX_START_DEPTH) {
      return yield* explained(
        `w.start is nested ${MAX_START_DEPTH} automations deep; an automation is probably starting itself in a loop.`,
        { fix: "Make sure the automations started with w.start don't start their starter again." },
      );
    }
    const target =
      (yield* deps.store.getAutomationByName(automation.project_id, name)) ??
      (yield* deps.resolveBuiltIn(name, automation));
    if (!target) {
      return yield* explained(`There's no automation named "${name}" in this project.`, {
        fix: "Use the exact meta.name of an automation saved in the same project.",
      });
    }
    if (target.enabled !== 1) {
      return yield* explained(`"${name}" is paused, so it can't be started.`, {
        fix: `Turn "${name}" back on, or run it by hand.`,
      });
    }
    const own = automationDefaults(automation).runtimeMode;
    const theirs = automationDefaults(target).runtimeMode;
    yield* resolveRuntimeMode(own, theirs).pipe(
      Effect.mapError(() =>
        explained(
          `"${name}" runs with ${theirs} access, more than this automation's ${own}, so it can't start it.`,
          {
            why: "An automation may only start automations that run with at most its own access.",
            fix: `Save this automation from a thread with ${theirs} access, or save "${name}" from a more limited one.`,
          },
        ),
      ),
    );
    const run = yield* deps.launchChild({ automation: target, input, parent });
    return { type: "done", value: { runId: run.id } } satisfies StepStart;
  });
