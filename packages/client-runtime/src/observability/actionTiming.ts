import type { ClientActionId, ClientActionTiming } from "@t3tools/contracts/clientActionTiming";

import { createActionTimingQueue } from "./actionTimingQueue.ts";

export interface ActionTimingFrame {
  readonly timestampMs: number;
  readonly method: NonNullable<ClientActionTiming["feedback"]>["method"];
}

export interface ActionTimingPlatform {
  readonly now: () => number;
  readonly foreground: () => boolean;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly afterCommit: (callback: (frame: ActionTimingFrame) => void) => () => void;
  readonly eventTimingMethod?: NonNullable<ClientActionTiming["eventTimingMethod"]>;
  readonly observeEventTiming?: (
    inputTimestampMs: number,
    callback: (elapsedMs: number) => void,
  ) => (() => void) | null;
  readonly subscribeForeground?: (callback: (foreground: boolean) => void) => () => void;
}

export interface ActionTimingHandle {
  /** Call from the committed view only when its meaningful feedback predicate holds. */
  readonly committed: (stage: "feedback" | "desiredState" | "both") => void;
  readonly acknowledged: () => void;
  readonly converged: () => void;
  readonly completed: () => void;
  readonly finish: (outcome: "success" | "rejected" | "abandoned") => void;
}

type Context = Pick<
  ClientActionTiming,
  "client" | "os" | "device" | "release" | "connection" | "mode"
>;
interface Activation {
  readonly action: ClientActionId;
  readonly entryPoint: ClientActionTiming["entryPoint"];
  readonly inputTimeMs: number | null;
  readonly activation: object;
  readonly path: ClientActionTiming["path"];
}

const EMPTY_HANDLE: ActionTimingHandle = {
  committed: () => {},
  acknowledged: () => {},
  converged: () => {},
  completed: () => {},
  finish: () => {},
};
const MAX_DURATION_MS = 86_400_000;
const DEADLINE_MS = 30_000;
const MAX_ACTIVE = 128;
const EVENT_TIMING_GRACE_MS = 1_000;

/** One recorder belongs to one signed-in destination. Reset before changing that destination. */
export function createActionTimingRecorder(options: {
  readonly platform: ActionTimingPlatform;
  readonly context: () => Context;
  readonly enabled: () => boolean;
  readonly correlationId: () => string;
  readonly send: (samples: ReadonlyArray<ClientActionTiming>) => Promise<unknown>;
}) {
  const { platform } = options;
  const queue = createActionTimingQueue({
    schedule: platform.schedule,
    send: options.send,
    enabled: options.enabled,
  });
  let activations = new WeakMap<object, ActionTimingHandle>();
  const active = new Set<() => void>();
  let disposed = false;
  let invalidInputs = 0;
  let dropped = 0;

  function hasConsent() {
    try {
      return options.enabled();
    } catch {
      return false;
    }
  }

  function safely<A>(read: () => A, fallback: A): A {
    try {
      return read();
    } catch {
      return fallback;
    }
  }
  const foreground = () => safely(platform.foreground, null);

  const elapsed = (input: number, timestamp = safely(platform.now, Number.NaN)): number | null => {
    const duration = timestamp - input;
    return Number.isFinite(duration) && duration >= 0 && duration <= MAX_DURATION_MS
      ? duration
      : null;
  };

  function begin(input: Activation): ActionTimingHandle {
    const existing = activations.get(input.activation);
    if (existing) return existing;
    if (disposed || !hasConsent()) return EMPTY_HANDLE;
    const inputTimeMs = input.inputTimeMs;
    if (
      inputTimeMs === null ||
      !Number.isFinite(inputTimeMs) ||
      inputTimeMs < 0 ||
      inputTimeMs > 1_000_000_000_000
    ) {
      invalidInputs += 1;
      return EMPTY_HANDLE;
    }
    const handlerDelayMs = elapsed(inputTimeMs);
    if (handlerDelayMs === null) {
      invalidInputs += 1;
      return EMPTY_HANDLE;
    }
    const inputTiming = { inputTimeMs, handlerDelayMs };
    if (active.size >= MAX_ACTIVE) {
      dropped += 1;
      return EMPTY_HANDLE;
    }
    let context: Context;
    let correlationId: string;
    try {
      context = options.context();
      correlationId = options.correlationId();
    } catch {
      dropped += 1;
      return EMPTY_HANDLE;
    }
    if (!/^(?!0{32}$)[a-f0-9]{32}$/.test(correlationId)) {
      invalidInputs += 1;
      return EMPTY_HANDLE;
    }
    let feedback: ClientActionTiming["feedback"] = null;
    let desiredState: ClientActionTiming["desiredState"] = null;
    let eventTimingMs: number | null = null;
    let eventTimingStatus: ClientActionTiming["eventTimingStatus"] = "unavailable";
    let waitingForEventTiming = false;
    let graceStarted = false;
    let acknowledgementMs: number | null = null;
    let convergenceMs: number | null = null;
    let completionMs: number | null = null;
    let outcome: "success" | "rejected" | "abandoned" | undefined;
    let finished = false;
    let pendingFrames = 0;
    const requestedStages = new Set<string>();
    const cancellations: Array<() => void> = [];

    function cancel() {
      finished = true;
      active.delete(cancel);
      for (const release of cancellations) safely(release, undefined);
    }

    function drop() {
      if (finished) return;
      dropped += 1;
      cancel();
    }

    function isForeground() {
      const visible = foreground();
      if (visible === null) drop();
      return visible === true;
    }

    function emit(override?: "background" | "no_feedback" | "abandoned") {
      if (finished) return;
      const finalOutcome =
        override === "background" && graceStarted && outcome !== undefined
          ? outcome
          : (override ?? outcome);
      if (finalOutcome === undefined) return;
      if (override === "background" && waitingForEventTiming && eventTimingMs === null) {
        eventTimingStatus = "cancelled";
      }
      cancel();
      if (!hasConsent()) return;
      queue.enqueue({
        ...context,
        action: input.action,
        entryPoint: input.entryPoint,
        path: input.path,
        ...inputTiming,
        feedback,
        desiredState,
        eventTimingMs,
        eventTimingMethod:
          eventTimingStatus === "unavailable" ? null : (platform.eventTimingMethod ?? null),
        eventTimingStatus,
        acknowledgementMs,
        convergenceMs,
        completionMs,
        outcome: finalOutcome,
        correlationId,
      });
    }

    function finishWhenReady() {
      if (outcome === undefined || pendingFrames > 0) return;
      // A successful RPC without a committed view is missing feedback, not a fast action.
      if (outcome === "success" && feedback === null && desiredState === null) return;
      // Event Timing arrives after presentation. Its grace stays inside the activation deadline.
      if (waitingForEventTiming && !graceStarted) {
        graceStarted = true;
        const release = safely(
          () =>
            platform.schedule(() => {
              waitingForEventTiming = false;
              if (eventTimingMs === null) eventTimingStatus = "no_entry";
              emit();
            }, EVENT_TIMING_GRACE_MS),
          null,
        );
        if (release) cancellations.push(release);
        else {
          waitingForEventTiming = false;
          if (eventTimingMs === null) eventTimingStatus = "unavailable";
        }
      }
      if (waitingForEventTiming) return;
      emit();
    }

    const handle: ActionTimingHandle = {
      committed(stage) {
        if (finished || !isForeground()) return;
        const stages = stage === "both" ? (["feedback", "desiredState"] as const) : [stage];
        const missing = stages.filter((item) => !requestedStages.has(item));
        if (missing.length === 0) return;
        for (const item of missing) requestedStages.add(item);
        pendingFrames += 1;
        const release = safely(
          () =>
            platform.afterCommit((frame) => {
              if (finished) return;
              pendingFrames -= 1;
              if (!isForeground()) {
                emit("background");
                return;
              }
              const elapsedMs = elapsed(inputTimeMs, frame.timestampMs);
              if (elapsedMs !== null) {
                const timing = { elapsedMs, method: frame.method };
                if (missing.includes("feedback") && feedback === null) feedback = timing;
                if (missing.includes("desiredState") && desiredState === null) {
                  desiredState = timing;
                  if (feedback === null) feedback = timing;
                }
              }
              finishWhenReady();
            }),
          null,
        );
        if (release) cancellations.push(release);
        else drop();
        if (finished && release) safely(release, undefined);
      },
      acknowledged() {
        if (!finished && acknowledgementMs === null) acknowledgementMs = elapsed(inputTimeMs);
      },
      converged() {
        if (!finished && convergenceMs === null) convergenceMs = elapsed(inputTimeMs);
      },
      completed() {
        if (!finished && completionMs === null) completionMs = elapsed(inputTimeMs);
      },
      finish(result) {
        if (finished || outcome !== undefined) return;
        outcome = result;
        if (!isForeground()) emit("background");
        else finishWhenReady();
      },
    };
    activations.set(input.activation, handle);
    active.add(cancel);
    const deadline = safely(
      () =>
        platform.schedule(() => {
          if (!isForeground()) emit("background");
          else
            emit(
              outcome === undefined
                ? "abandoned"
                : feedback === null && desiredState === null
                  ? "no_feedback"
                  : undefined,
            );
        }, DEADLINE_MS),
      null,
    );
    if (!deadline) {
      cancel();
      dropped += 1;
      return EMPTY_HANDLE;
    }
    cancellations.push(deadline);
    const subscribeForeground = platform.subscribeForeground;
    if (subscribeForeground) {
      const release = safely(
        () =>
          subscribeForeground((visible) => {
            if (!visible) emit("background");
          }),
        null,
      );
      if (release) cancellations.push(release);
    }
    const observeEventTiming = platform.observeEventTiming;
    if (observeEventTiming) {
      const release = safely(
        () =>
          observeEventTiming(inputTimeMs, (duration) => {
            if (
              !finished &&
              Number.isFinite(duration) &&
              duration >= 0 &&
              duration <= MAX_DURATION_MS
            ) {
              eventTimingMs = Math.max(eventTimingMs ?? 0, duration);
              eventTimingStatus = "observed";
            }
          }),
        null,
      );
      if (release) {
        cancellations.push(release);
        waitingForEventTiming = true;
        if (eventTimingMs === null) eventTimingStatus = "no_entry";
      }
    }
    if (!isForeground()) emit("background");
    return handle;
  }

  function reset() {
    for (const cancel of Array.from(active)) cancel();
    activations = new WeakMap();
    queue.clear();
  }

  return {
    begin,
    reset,
    flush: queue.flush,
    stats: () => ({
      ...queue.stats(),
      active: active.size,
      invalidInputs,
      droppedActivations: dropped,
    }),
    dispose() {
      disposed = true;
      reset();
      queue.dispose();
    },
  };
}
