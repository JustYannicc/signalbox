import type { WorkflowStepVerb } from "@t3tools/contracts";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

import { installGuestGlobals } from "./guestGlobals.ts";
import { installGuestRuntime } from "./guestRuntime.ts";

/** What the journal knows about a step that finished; `at` is when it finished, in epoch ms. */
export type JournalResult =
  | { readonly ok: true; readonly value: unknown; readonly at: number }
  | { readonly ok: false; readonly error: string; readonly at: number };

/** A step the code reached that has no result yet. */
export interface StepRequest {
  readonly key: string;
  readonly verb: WorkflowStepVerb;
  readonly label: string;
  readonly args: ReadonlyArray<unknown>;
}

export interface ReplayInput {
  readonly script: string;
  readonly input: unknown;
  /** What started the run, passed as the workflow callback's third argument; null when omitted. */
  readonly trigger?: unknown;
  /** The run's start, in epoch ms: what `Date.now()` returns before any step finished. */
  readonly startedAt: number;
  /** Seeds `Math.random` and `crypto`; use the run id so every replay draws the same values. */
  readonly seed: string;
  /** Looks a step up in the journal. Throw-free; return undefined while it's pending. */
  readonly result: (step: {
    key: string;
    verb: WorkflowStepVerb;
    label: string;
  }) => JournalResult | undefined;
  readonly timeLimitMs?: number;
  readonly memoryLimitBytes?: number;
}

/** One `console` call; `at` is the automation's deterministic time when it logged. */
export interface ReplayLog {
  readonly level: "log" | "info" | "warn" | "error" | "debug";
  readonly message: string;
  readonly at: number;
}

/**
 * `requests` lists every pending step the replay reached, including ones
 * already started earlier; `marks` holds branch decisions and loop counts for
 * the run view, keyed like steps. `logs` holds the newest lines the code
 * logged in this replay (200 at most, 64 KB in all); replays are
 * deterministic, so the latest one covers the whole run so far.
 */
export type ReplayOutcome = (
  | { readonly type: "completed"; readonly output: unknown }
  /** The code returned `w.restart(input)`. */
  | { readonly type: "restart"; readonly input: unknown }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "suspended" }
) & {
  readonly requests: ReadonlyArray<StepRequest>;
  readonly marks: ReadonlyMap<string, unknown>;
  readonly logs: ReadonlyArray<ReplayLog>;
};

const MODULE_NAME = "automation.js";
const DEFAULT_TIME_LIMIT_MS = 5_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** The newest lines win: what the code logged last is what explains where it got. */
const MAX_LOGS = 200;
const MAX_LOG_BYTES = 64 * 1024;
const MAX_LOG_LENGTH = 2_000;
const LOG_LEVELS = new Set<string>(["log", "info", "warn", "error", "debug"]);
const GUEST_RUNTIME = `(${installGuestGlobals.toString()})();\n(${installGuestRuntime.toString()})();`;

let quickJS: Promise<QuickJSWASMModule> | undefined;
const loadQuickJS = () =>
  (quickJS ??= newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-wasmfile-release-sync")));

/** FNV-1a, to turn the run id into a 32-bit seed. */
function hashSeed(seed: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function errorMessage(context: QuickJSContext, handle: QuickJSHandle) {
  const error = context.dump(handle) as unknown;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message: unknown }).message);
    return message === "interrupted"
      ? "The automation's code ran too long between steps."
      : message;
  }
  return String(error);
}

/**
 * Runs an automation from the top in a fresh QuickJS sandbox, answering steps
 * from the journal. Code is replayed after every step that finishes, so the
 * sandbox never outlives one call and holds nothing durable.
 */
export async function replayWorkflow(options: ReplayInput): Promise<ReplayOutcome> {
  const runtime = (await loadQuickJS()).newRuntime();
  runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
  // A wall-clock budget for one replay; it only guards against runaway code.
  const deadline = performance.now() + (options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS);
  runtime.setInterruptHandler(() => performance.now() > deadline);
  const context = runtime.newContext();

  const requests = new Map<string, StepRequest>();
  const marks = new Map<string, unknown>();
  const logs: ReplayLog[] = [];
  let logBytes = 0;
  let dropped = 0;
  let hostError: string | null = null;
  const finish = (
    outcome:
      | { type: "completed"; output: unknown }
      | { type: "restart"; input: unknown }
      | { type: "failed"; error: string }
      | { type: "suspended" },
  ): ReplayOutcome => {
    if (dropped > 0) {
      const lines = dropped === 1 ? "1 earlier log line was" : `${dropped} earlier log lines were`;
      logs.unshift({ level: "warn", message: `${lines} dropped.`, at: logs[0]?.at ?? 0 });
    }
    return { ...outcome, requests: [...requests.values()], marks, logs };
  };

  try {
    const host = context.newObject();
    const step = context.newFunction("step", (keyHandle, verbHandle, labelHandle, argsHandle) => {
      const key = context.getString(keyHandle);
      const verb = context.getString(verbHandle) as WorkflowStepVerb;
      const label = context.getString(labelHandle);
      const result = options.result({ key, verb, label });
      if (result) return context.newString(JSON.stringify(result));
      if (!requests.has(key)) {
        let args: unknown[] = [];
        try {
          args = JSON.parse(context.getString(argsHandle)) as unknown[];
        } catch {
          hostError ??= `Step ${key} was given arguments that aren't plain data.`;
        }
        requests.set(key, { key, verb, label, args });
      }
      return context.null;
    });
    const mark = context.newFunction("mark", (keyHandle, valueHandle) => {
      marks.set(context.getString(keyHandle), JSON.parse(context.getString(valueHandle)));
    });
    const log = context.newFunction("log", (levelHandle, messageHandle, atHandle) => {
      const level = context.getString(levelHandle);
      const text = context.getString(messageHandle);
      const message = text.length > MAX_LOG_LENGTH ? `${text.slice(0, MAX_LOG_LENGTH - 1)}…` : text;
      logs.push({
        level: LOG_LEVELS.has(level) ? (level as ReplayLog["level"]) : "log",
        message,
        at: context.getNumber(atHandle),
      });
      logBytes += message.length;
      while (logs.length > MAX_LOGS || logBytes > MAX_LOG_BYTES) {
        logBytes -= logs.shift()!.message.length;
        dropped++;
      }
    });
    const seed = context.newNumber(hashSeed(options.seed));
    const startedAt = context.newNumber(options.startedAt);
    context.setProp(host, "seed", seed);
    context.setProp(host, "startedAt", startedAt);
    seed.dispose();
    startedAt.dispose();
    context.setProp(host, "step", step);
    context.setProp(host, "mark", mark);
    context.setProp(host, "log", log);
    context.setProp(context.global, "__host", host);
    for (const handle of [step, mark, log, host]) handle.dispose();

    const installed = context.evalCode(GUEST_RUNTIME, "runtime.js");
    if (installed.error) {
      const error = errorMessage(context, installed.error);
      installed.error.dispose();
      return finish({ type: "failed", error: `The automation runtime failed to start: ${error}` });
    }
    installed.value.dispose();

    const evaluated = context.evalCode(options.script, MODULE_NAME, { type: "module" });
    if (evaluated.error) {
      const error = errorMessage(context, evaluated.error);
      evaluated.error.dispose();
      return finish({ type: "failed", error });
    }
    const namespace = evaluated.value;
    const definition = context.getProp(namespace, "default");
    const run = context.getProp(context.global, "__run");
    const input = context.newString(JSON.stringify(options.input ?? null));
    const trigger = context.newString(JSON.stringify(options.trigger ?? null));
    const called = context.callFunction(run, context.undefined, definition, input, trigger);
    for (const handle of [namespace, definition, run, input, trigger]) handle.dispose();
    if (called.error) {
      const error = errorMessage(context, called.error);
      called.error.dispose();
      return finish({ type: "failed", error });
    }

    const promise = called.value;
    const settleNext = context.getProp(context.global, "__settleNext");
    try {
      // Run jobs until the code is waiting on steps, then settle the journaled
      // step that finished first and go again, so continuations replay in the
      // order they happened.
      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          const error = errorMessage(context, jobs.error);
          jobs.error.dispose();
          return finish({ type: "failed", error });
        }
        if (jobs.value > 0) continue;
        const settled = context.callFunction(settleNext, context.undefined);
        if (settled.error) {
          const error = errorMessage(context, settled.error);
          settled.error.dispose();
          return finish({ type: "failed", error });
        }
        const more = context.dump(settled.value) === true;
        settled.value.dispose();
        if (!more) break;
      }
      if (hostError) return finish({ type: "failed", error: hostError });
      const state = context.getPromiseState(promise);
      if (state.type === "pending") return finish({ type: "suspended" });
      if (state.type === "rejected") {
        const error = errorMessage(context, state.error);
        state.error.dispose();
        return finish({ type: "failed", error });
      }
      const result = JSON.parse(context.getString(state.value)) as
        | { readonly restart: true; readonly input: unknown }
        | { readonly restart: false; readonly output: unknown };
      state.value.dispose();
      return finish(
        result.restart
          ? { type: "restart", input: result.input }
          : { type: "completed", output: result.output },
      );
    } finally {
      settleNext.dispose();
      promise.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
