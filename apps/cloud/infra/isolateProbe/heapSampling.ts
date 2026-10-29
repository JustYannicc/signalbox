// @effect-diagnostics globalTimers:off - Inspector deadlines also run inside the probe Worker without an Effect runtime.
export interface SamplingClock {
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

export const systemSamplingClock: SamplingClock = {
  now: () => performance.timeOrigin + performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export interface ResponseSample<Context> {
  readonly id: string;
  readonly context: Context;
  readonly respondedAtMs: number;
}

interface ResponseTiming {
  readonly generation: string;
  readonly respondedAtMs: number;
  readonly enqueuedAtMs: number;
  readonly deadlineAtMs: number;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number;
}

export type ResponseSampleOutcome<Context, Value> = ResponseSample<Context> &
  ResponseTiming &
  (
    | { readonly status: "sampled"; readonly value: Value }
    | {
        readonly status: "gap";
        readonly reason: string;
        readonly error?: unknown;
      }
  );

interface SampleJob<Context> {
  readonly response: ResponseSample<Context>;
  readonly generation: string;
  readonly enqueuedAtMs: number;
  readonly deadlineAtMs: number;
  readonly controller: AbortController;
  cancelDeadline: () => void;
  startedAtMs: number | null;
  settled: boolean;
}

interface ResponseSamplingOptions<Context, Value> {
  readonly generation: string;
  readonly sample: (
    context: Context,
    attempt: {
      readonly signal: AbortSignal;
      readonly generation: string;
      readonly respondedAtMs: number;
      readonly deadlineAtMs: number;
    },
  ) => Promise<Value>;
  readonly onOutcome: (outcome: ResponseSampleOutcome<Context, Value>) => void;
  readonly onPendingChange?: (pending: number) => void;
  readonly timeoutMs: number;
  readonly maxPending?: number;
  readonly clock?: SamplingClock;
}

/** Keeps measurement admission independent of the response that triggered it. */
export function createResponseSamplingQueue<Context, Value>(
  options: ResponseSamplingOptions<Context, Value>,
) {
  const { sample, onOutcome, timeoutMs, maxPending = 512, clock = systemSamplingClock } = options;
  if (
    !options.generation ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxPending) ||
    maxPending < 1
  ) {
    throw new Error("Invalid response sampling queue configuration");
  }

  let generation = options.generation;
  let closed = false;
  let active: SampleJob<Context> | undefined;
  let sampled = 0;
  let gaps = 0;
  let outcomeFailures = 0;
  let duplicateResponses = 0;
  let deferredOutcomes = 0;
  const seen = new Set<string>();
  const generations = new Map<string, { responses: number; sampled: number; gaps: number }>();
  const generationCounts = () => {
    let counts = generations.get(generation);
    if (!counts) {
      counts = { responses: 0, sampled: 0, gaps: 0 };
      generations.set(generation, counts);
    }
    return counts;
  };
  const queue: SampleJob<Context>[] = [];
  const pending = new Set<SampleJob<Context>>();
  const idleWaiters = new Set<() => void>();

  function reportPending() {
    try {
      options.onPendingChange?.(pending.size + (active?.settled ? 1 : 0));
    } catch {
      outcomeFailures++;
    }
  }

  function notifyIdle() {
    if (pending.size || active || deferredOutcomes) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function finish(
    job: SampleJob<Context>,
    outcome:
      | { status: "sampled"; value: Value }
      | { status: "gap"; reason: string; error?: unknown },
  ) {
    if (job.settled) return;
    job.settled = true;
    job.cancelDeadline();
    pending.delete(job);
    reportPending();
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
    if (outcome.status === "sampled") sampled++;
    else gaps++;
    const counts = generations.get(job.generation)!;
    if (outcome.status === "sampled") counts.sampled++;
    else counts.gaps++;
    try {
      onOutcome({
        ...job.response,
        generation: job.generation,
        respondedAtMs: job.response.respondedAtMs,
        enqueuedAtMs: job.enqueuedAtMs,
        deadlineAtMs: job.deadlineAtMs,
        startedAtMs: job.startedAtMs,
        completedAtMs: clock.now(),
        ...outcome,
      });
    } catch {
      // A failed recorder must fail coverage instead of taking down serving.
      outcomeFailures++;
    }
    notifyIdle();
  }

  function expire(job: SampleJob<Context>) {
    const reason =
      job.startedAtMs === null ? "deadline-expired-in-queue" : "deadline-expired-in-flight";
    job.controller.abort(new Error(reason));
    finish(job, { status: "gap", reason });
  }

  async function pump() {
    if (active) return;
    const job = queue.shift();
    if (!job) {
      notifyIdle();
      return;
    }
    if (clock.now() >= job.deadlineAtMs) {
      expire(job);
      void pump();
      return;
    }

    active = job;
    job.startedAtMs = clock.now();
    try {
      const value = await sample(job.response.context, {
        signal: job.controller.signal,
        generation: job.generation,
        respondedAtMs: job.response.respondedAtMs,
        deadlineAtMs: job.deadlineAtMs,
      });
      if (!job.settled) {
        if (clock.now() >= job.deadlineAtMs) expire(job);
        else finish(job, { status: "sampled", value });
      }
    } catch (error) {
      finish(job, { status: "gap", reason: "sample-error", error });
    } finally {
      // Abort or a deadline does not prove that the transport has actually joined.
      active = undefined;
      reportPending();
      void pump();
      notifyIdle();
    }
  }

  function cancelPending(reason: string) {
    for (const job of [...pending]) {
      job.controller.abort(new Error(reason));
      finish(job, { status: "gap", reason });
    }
  }

  function deferGap(job: SampleJob<Context>, reason: string) {
    deferredOutcomes++;
    queueMicrotask(() => {
      finish(job, { status: "gap", reason });
      deferredOutcomes--;
      notifyIdle();
    });
  }

  return {
    enqueue(response: ResponseSample<Context>) {
      const key = generation + "\0" + response.id;
      if (seen.has(key)) {
        duplicateResponses++;
        return;
      }
      seen.add(key);
      generationCounts().responses++;
      const enqueuedAtMs = clock.now();
      const job: SampleJob<Context> = {
        response,
        generation,
        enqueuedAtMs,
        deadlineAtMs: response.respondedAtMs + timeoutMs,
        controller: new AbortController(),
        cancelDeadline: () => undefined,
        startedAtMs: null,
        settled: false,
      };
      if (!Number.isFinite(response.respondedAtMs) || response.respondedAtMs > enqueuedAtMs) {
        deferGap(job, "invalid-response-time");
      } else if (closed) {
        deferGap(job, "queue-closed");
      } else if (pending.size >= maxPending) {
        deferGap(job, "queue-capacity");
      } else {
        pending.add(job);
        reportPending();
        queue.push(job);
        job.cancelDeadline = clock.schedule(
          () => expire(job),
          Math.max(0, job.deadlineAtMs - enqueuedAtMs),
        );
        queueMicrotask(() => void pump());
      }
    },
    changeGeneration(next: string) {
      if (!next) throw new Error("A sampling generation is required");
      if (next === generation) return;
      cancelPending("generation-changed");
      generation = next;
    },
    drain() {
      if (!pending.size && !active && !deferredOutcomes) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
    async close({ cancel = false } = {}) {
      closed = true;
      if (cancel) cancelPending("queue-closed");
      if (pending.size || active || deferredOutcomes) {
        await new Promise<void>((resolve) => idleWaiters.add(resolve));
      }
    },
    snapshot() {
      return {
        generation,
        closed,
        responses: seen.size,
        queued: queue.length,
        inFlight: active ? 1 : 0,
        pending: pending.size,
        sampled,
        gaps,
        outcomeFailures,
        duplicateResponses,
        generations: [...generations].map(([id, counts]) => ({ generation: id, ...counts })),
      };
    },
  };
}
