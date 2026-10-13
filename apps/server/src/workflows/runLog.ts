import {
  AutomationError,
  type AutomationErrorDetail,
  type AutomationRunLog,
  type AutomationRunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  createError,
  createRequestLogger,
  EvlogError,
  initLogger,
  type RequestLogger,
} from "evlog";
import { createFsDrain } from "evlog/fs";

import { ServerConfig } from "../config.ts";
import { causeChain } from "./stepPolicy.ts";
import type { AutomationRow, RunRow, StepRow } from "./WorkflowStore.ts";

/**
 * Automation observability with evlog, kept to this module so the server's
 * Effect logger stays as it is: one wide event per run, with every step's
 * outcome and the code's newest console lines, written as NDJSON under
 * `<stateDir>/logs/automations/` (pretty in the terminal during dev). Failures
 * are evlog structured errors, so runs and steps can say why and what to do.
 */

/** Steps recorded per run event; long loops keep the first ones and count the rest. */
const MAX_STEPS = 200;
const LOG_FILES = 14;
const LOG_FILE_BYTES = 10 * 1024 * 1024;

/** An AutomationError that explains itself: why it happened and what to do next. */
export function explained(
  message: string,
  help: {
    readonly why?: string;
    readonly fix?: string;
    readonly link?: string;
    readonly cause?: unknown;
  },
) {
  return new AutomationError({
    message,
    cause: createError({
      message,
      ...(help.why === undefined ? {} : { why: help.why }),
      ...(help.fix === undefined ? {} : { fix: help.fix }),
      ...(help.link === undefined ? {} : { link: help.link }),
      ...(help.cause instanceof Error ? { cause: help.cause } : {}),
    }),
  });
}

/** The why/fix/link of the first structured error in `error`'s causes. */
export function errorDetail(error: unknown): AutomationErrorDetail | null {
  for (const cause of causeChain(error)) {
    if (!EvlogError.isEvlogError(cause)) continue;
    if (cause.why === undefined && cause.fix === undefined && cause.link === undefined) continue;
    return { why: cause.why ?? null, fix: cause.fix ?? null, link: cause.link ?? null };
  }
  return null;
}

export interface StepRecord {
  readonly status: "running" | "waiting" | "retrying" | "succeeded" | "failed";
  readonly durationMs?: number;
  readonly error?: string;
  readonly detail?: AutomationErrorDetail | null;
}

export interface RunEnd {
  readonly status: AutomationRunStatus;
  readonly error: string | null;
  readonly detail: AutomationErrorDetail | null;
  readonly logs: ReadonlyArray<AutomationRunLog>;
  readonly durationMs: number;
}

const ms = (iso: string) => DateTime.makeUnsafe(iso).epochMilliseconds;

export const makeRunLogs = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const dev = config.devUrl !== undefined;
  initLogger({ env: { service: "signalbox-automations" }, pretty: dev, silent: !dev });
  const drain = createFsDrain({
    dir: path.join(config.stateDir, "logs", "automations"),
    maxFiles: LOG_FILES,
    maxSizePerFile: LOG_FILE_BYTES,
    pretty: false,
  });

  // One open event per running run. A restart loses the open ones; the next
  // touch reopens the run's event marked `resumed`, so its trail starts there.
  const open = new Map<
    string,
    { readonly log: RequestLogger; readonly steps: Set<string>; readonly omitted: Set<string> }
  >();
  // Runs whose event was written. A step fiber can still report after its run
  // ended (a cancel or timeout races it); that must not reopen the event.
  const closed = new Set<string>();
  const eventFor = (runId: string) => {
    let entry = open.get(runId);
    if (!entry) {
      entry = {
        log: createRequestLogger({ requestId: runId }),
        steps: new Set(),
        omitted: new Set(),
      };
      entry.log.set({ run: { id: runId }, resumed: true });
      open.set(runId, entry);
    }
    return entry;
  };
  type RunFacts = Pick<RunRow, "run_id" | "version" | "trigger" | "parent_run_id" | "depth">;
  const describeRun = (
    run: RunFacts,
    automation: Pick<AutomationRow, "automation_id" | "name">,
  ) => ({
    automation: { id: automation.automation_id, name: automation.name, version: run.version },
    run: {
      id: run.run_id,
      trigger: run.trigger,
      ...(run.parent_run_id === null ? {} : { parentRunId: run.parent_run_id }),
      depth: run.depth,
    },
  });

  return {
    /** Opens the run's event. */
    started: (run: RunFacts, automation: Pick<AutomationRow, "automation_id" | "name">) =>
      Effect.sync(() => {
        const log = createRequestLogger({ requestId: run.run_id });
        log.set(describeRun(run, automation));
        open.set(run.run_id, { log, steps: new Set(), omitted: new Set() });
      }),

    /** Records where a step got: its latest state wins in the run's event. */
    step: (
      step: Pick<StepRow, "run_id" | "step_key" | "verb" | "label" | "attempt">,
      record: StepRecord,
    ) =>
      Effect.sync(() => {
        if (closed.has(step.run_id)) return;
        const { log, steps, omitted } = eventFor(step.run_id);
        if (!steps.has(step.step_key)) {
          if (steps.size >= MAX_STEPS) {
            omitted.add(step.step_key);
            log.set({ stepsOmitted: omitted.size });
            return;
          }
          steps.add(step.step_key);
        }
        log.set({
          steps: {
            [step.step_key]: {
              verb: step.verb,
              label: step.label,
              status: record.status,
              attempt: step.attempt,
              ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
              ...(record.error === undefined
                ? {}
                : { error: { message: record.error, ...record.detail } }),
            },
          },
        });
      }),

    /** Closes the run's event and writes it out. */
    finished: (
      run: RunRow,
      automation: Pick<AutomationRow, "automation_id" | "name"> | undefined,
      end: RunEnd,
    ) =>
      Effect.gen(function* () {
        const event = yield* Effect.sync(() => {
          const { log } = eventFor(run.run_id);
          open.delete(run.run_id);
          closed.add(run.run_id);
          if (automation) log.set(describeRun(run, automation));
          if (end.logs.length > 0) {
            log.set({
              console: end.logs.map((line) => `${line.at} ${line.level} ${line.message}`),
            });
          }
          if (end.status === "failed") {
            log.error(
              createError({
                message: end.error ?? "The run failed.",
                ...(end.detail?.why ? { why: end.detail.why } : {}),
                ...(end.detail?.fix ? { fix: end.detail.fix } : {}),
                ...(end.detail?.link ? { link: end.detail.link } : {}),
              }),
            );
          } else if (end.status === "cancelled") {
            log.warn("The run was cancelled.");
          }
          return log.emit({ outcome: end.status, _durationMs: end.durationMs });
        });
        if (event) yield* Effect.promise(() => Promise.resolve(drain({ event })));
      }),

    /** Forgets every run but `running` ones; cleanup calls it now and then. */
    sweep: (running: ReadonlySet<string>) =>
      Effect.sync(() => {
        closed.clear();
        for (const runId of open.keys()) if (!running.has(runId)) open.delete(runId);
      }),

    /** How long a step ran, from its stored times. */
    durationOf: (step: Pick<StepRow, "started_at" | "finished_at">) =>
      step.finished_at === null ? undefined : ms(step.finished_at) - ms(step.started_at),
  };
});

export type RunLogs = Effect.Success<typeof makeRunLogs>;
