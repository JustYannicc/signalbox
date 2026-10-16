import {
  AutomationError,
  EXTERNAL_RUN_SYSTEM_NAMES,
  ExternalRunSystem,
  type ExternalRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { externalRunOf } from "./columns.ts";
import type { Settlement } from "./engineTypes.ts";
import { toJson } from "./json.ts";
import { explained } from "./runLog.ts";
import type { StepStart } from "./steps.ts";
import { describeDuration, durationMs } from "./stepPolicy.ts";
import { isoAt, isoMs } from "./time.ts";
import type { AutomationRow, StepRow, WorkflowStore } from "./WorkflowStore.ts";

/**
 * Steps that run in another system. `w.run(label, { on: "github-actions" },
 * fn, ...args)` sends the function to the folder repository's CI instead of
 * the host. The step waits while the engine reads the run there, so its jobs
 * and steps show live in the run, and settles with the function's result.
 * Hosts register the systems they reach (the cloud: GitHub Actions).
 */

export interface ExternalDispatch {
  readonly projectId: string;
  /** `run_id/step_key`: unique, so a dispatch repeated after a crash can find its run. */
  readonly stepId: string;
  readonly label: string;
  /** The version's `w.run` module, its imports installed where it runs. */
  readonly module: string;
  readonly name: string;
  readonly args: ReadonlyArray<unknown>;
  /** The step's options besides `on`, e.g. `ref`, `environment`, `secrets`. */
  readonly options: Readonly<Record<string, unknown>>;
}

export interface ExternalRead {
  readonly run: ExternalRun;
  /** Once it finished: the function's result, or why it failed. */
  readonly outcome?: Settlement;
}

export interface ExternalRunner {
  readonly dispatch: (input: ExternalDispatch) => Effect.Effect<ExternalRun, AutomationError>;
  readonly read: (
    projectId: string,
    run: ExternalRun,
  ) => Effect.Effect<ExternalRead, AutomationError>;
  /** Stops a run its step no longer waits for. */
  readonly cancel: (projectId: string, run: ExternalRun) => Effect.Effect<void, AutomationError>;
}

/** How long a step on another system may take unless it says: GitHub's own job limit. */
export const DEFAULT_EXTERNAL_TIMEOUT_MS = 6 * 3_600_000;

/** Every 10 seconds while a run is young, then every 30; a read that failed waits a minute. */
export const nextPollDelayMs = (startedAt: string, now: number) =>
  now - isoMs(startedAt) < 120_000 ? 10_000 : 30_000;
const FAILED_READ_DELAY_MS = 60_000;

export const isExternalRunSystem = Schema.is(ExternalRunSystem);

export const makeExternalRuns = (deps: {
  readonly store: WorkflowStore;
  readonly complete: (
    runId: string,
    key: string,
    outcome: Settlement,
  ) => Effect.Effect<boolean, AutomationError>;
  readonly runChanged: (runId: string, summary: boolean) => Effect.Effect<void, AutomationError>;
  readonly automationOfRun: (
    runId: string,
  ) => Effect.Effect<AutomationRow | undefined, AutomationError>;
}) => {
  const { store } = deps;
  const runners = new Map<ExternalRunSystem, ExternalRunner>();

  const runnerFor = (system: ExternalRunSystem) => {
    const runner = runners.get(system);
    return runner
      ? Effect.succeed(runner)
      : Effect.fail(
          explained(`w.run can't run on ${EXTERNAL_RUN_SYSTEM_NAMES[system]} here.`, {
            why: "Only Signalbox Cloud sends functions to a folder repository's CI.",
            fix: "Run this automation in a cloud folder that comes from a GitHub repository, or leave out `on`.",
          }),
        );
  };

  /** Dispatches the step's function and has it wait for the run, read again shortly. */
  const start = (
    automation: AutomationRow,
    step: StepRow,
    input: {
      readonly on: ExternalRunSystem;
      readonly options: Readonly<Record<string, unknown>>;
      readonly module: string | null;
      readonly name: string;
      readonly args: ReadonlyArray<unknown>;
    },
  ): Effect.Effect<StepStart, AutomationError> =>
    Effect.gen(function* () {
      if (input.module === null)
        return yield* new AutomationError({
          message: `${input.name} isn't a w.run function in this automation.`,
        });
      const runner = yield* runnerFor(input.on);
      const { on: _on, timeout, ...options } = input.options;
      const external = yield* runner.dispatch({
        projectId: automation.project_id,
        stepId: `${step.run_id}/${step.step_key}`,
        label: step.label,
        module: input.module,
        name: input.name,
        args: input.args,
        options,
      });
      const now = (yield* DateTime.now).epochMilliseconds;
      const limit = durationMs(timeout) ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
      return {
        type: "waiting",
        wakeAt: isoAt(isoMs(step.started_at) + limit),
        external,
        pollAt: isoAt(now + nextPollDelayMs(step.started_at, now)),
      };
    });

  /** Reads one waiting step's run: shows what changed, and settles the step once it finished. */
  const pollStep = (step: StepRow, now: number) =>
    Effect.gen(function* () {
      if (!step.external_json) return;
      const current = externalRunOf(step.external_json);
      const automation = yield* deps.automationOfRun(step.run_id);
      const runner = runners.get(current.system);
      if (!automation || !runner) {
        yield* store.saveExternal(step.run_id, step.step_key, step.external_json, null);
        return;
      }
      const read = yield* runner.read(automation.project_id, current).pipe(
        Effect.catch((error) =>
          Effect.logWarning("An automation step's external run couldn't be read", {
            runId: step.run_id,
            system: current.system,
            error: error.message,
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (read === undefined) {
        yield* store.saveExternal(
          step.run_id,
          step.step_key,
          step.external_json,
          isoAt(now + FAILED_READ_DELAY_MS),
        );
        return;
      }
      const json = toJson(read.run);
      // A finished run is read once more if settling it fails, never left unread.
      const saved = yield* store.saveExternal(
        step.run_id,
        step.step_key,
        json,
        isoAt(now + (read.outcome ? FAILED_READ_DELAY_MS : nextPollDelayMs(step.started_at, now))),
      );
      if (!saved) return;
      if (read.outcome) yield* deps.complete(step.run_id, step.step_key, read.outcome);
      else if (json !== step.external_json) yield* deps.runChanged(step.run_id, false);
    });

  /** Reads every external run that's due, a few at once. A read that breaks is tried again later. */
  const poll = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const later = isoAt(now.epochMilliseconds + FAILED_READ_DELAY_MS);
    yield* Effect.forEach(
      yield* store.duePolls(DateTime.formatIso(now)),
      (step) =>
        pollStep(step, now.epochMilliseconds).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Automation external run poll failed", { cause }).pipe(
              Effect.andThen(
                store.saveExternal(step.run_id, step.step_key, step.external_json ?? "null", later),
              ),
              Effect.ignore,
            ),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Automation external polls failed", { cause })),
  );

  /** Stops a step's run, ignoring a system that can't be told. */
  const cancel = (projectId: string, step: StepRow) =>
    Effect.gen(function* () {
      if (!step.external_json) return;
      const current = externalRunOf(step.external_json);
      const runner = runners.get(current.system);
      if (!runner) return;
      yield* runner.cancel(projectId, current).pipe(
        Effect.catch((error) =>
          Effect.logWarning("An automation step's external run couldn't be stopped", {
            system: current.system,
            error: error.message,
          }),
        ),
      );
    });

  /** A step whose run went past its timeout: stop the run and fail the step. */
  const timeOut = (step: StepRow) =>
    Effect.gen(function* () {
      const automation = yield* deps.automationOfRun(step.run_id);
      if (automation) yield* cancel(automation.project_id, step);
      const current = step.external_json ? externalRunOf(step.external_json) : undefined;
      const limit = isoMs(step.wake_at ?? step.started_at) - isoMs(step.started_at);
      yield* deps.complete(step.run_id, step.step_key, {
        ok: false,
        error: `${current ? EXTERNAL_RUN_SYSTEM_NAMES[current.system] : "The runner"} didn't finish within ${describeDuration(limit)}.`,
        detail: {
          why: null,
          fix: 'Give the step more time, e.g. { on: "github-actions", timeout: { hours: 2 } }, or check why the run is stuck.',
          link: current?.url ?? null,
        },
      });
    });

  return {
    register: (system: ExternalRunSystem, runner: ExternalRunner) =>
      Effect.sync(() => void runners.set(system, runner)),
    start,
    poll,
    timeOut,
    cancel,
    /** When the next external run is due to be read (epoch ms); null when none is. */
    nextPollAt: store.nextPollAt().pipe(Effect.map((at) => (at === null ? null : isoMs(at)))),
  };
};

export type ExternalRuns = ReturnType<typeof makeExternalRuns>;
