import { systemSamplingClock, type SamplingClock } from "./heapSampling.ts";

export interface HeapInspectorSampleContext {
  readonly generation: string;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
  readonly boundary?: string;
}

export interface HeapUsageObservation {
  readonly generation: string;
  readonly isolateId: string;
  readonly usedSize: number;
  readonly totalSize: number;
  readonly embedderHeapUsedSize: number | null;
  readonly backingStorageSize: number | null;
  readonly readStartedAtMs: number;
  readonly readAcknowledgedAtMs: number;
  readonly requestProgress?: { readonly before: unknown; readonly after: unknown };
}

export interface HeapInspectorSample {
  readonly kind: "response" | "interval";
  readonly generation: string;
  readonly isolateId: string;
  readonly boundary: string | null;
  readonly granularity: "isolate-aggregate";
  readonly measurement: "pre-gc-inspector-observations";
  readonly gc: { readonly method: null; readonly acknowledged: false };
  readonly observations: readonly HeapUsageObservation[];
}

export type HeapInspectorGapCode =
  | "invalid-context"
  | "queue-closed"
  | "queue-capacity"
  | "stale-generation"
  | "generation-changed"
  | "aborted"
  | "deadline-expired"
  | "isolate-identity-failed"
  | "isolate-identity-invalid"
  | "isolate-identity-unavailable"
  | "inspector-call-failed"
  | "invalid-heap-usage"
  | "generation-invalidated";

export class HeapInspectorGapError extends Error {
  readonly code: HeapInspectorGapCode;
  readonly method: string | null;
  override readonly cause: unknown;

  constructor(
    code: HeapInspectorGapCode,
    options: { readonly method?: string; readonly cause?: unknown } = {},
  ) {
    super(options.method === undefined ? code : `${code}:${options.method}`);
    this.name = "HeapInspectorGapError";
    this.code = code;
    this.method = options.method ?? null;
    this.cause = options.cause;
  }
}

type InspectorCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

interface HeapInspectorOptions {
  readonly clock?: SamplingClock;
  readonly maxPending?: number;
  readonly readContext?: () => unknown;
}

interface SampleJob {
  readonly kind: "response" | "interval";
  readonly context: HeapInspectorSampleContext;
  readonly resolve: (sample: HeapInspectorSample) => void;
  readonly reject: (error: HeapInspectorGapError) => void;
  cancelDeadline: (() => void) | null;
  abortHandler: (() => void) | null;
  invalidatedReason: HeapInspectorGapError | null;
  settled: boolean;
}

type IdentityState =
  | { readonly status: "known"; readonly isolateId: string }
  | { readonly status: "failed"; readonly error: HeapInspectorGapError };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function identityFrom(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return undefined;
  return value.id;
}

function usageFrom(
  value: unknown,
):
  | Omit<
      HeapUsageObservation,
      "generation" | "isolateId" | "readStartedAtMs" | "readAcknowledgedAtMs"
    >
  | undefined {
  if (!isRecord(value)) return undefined;
  const { usedSize, totalSize } = value;
  if (
    typeof usedSize !== "number" ||
    typeof totalSize !== "number" ||
    !Number.isSafeInteger(usedSize) ||
    usedSize < 0 ||
    !Number.isSafeInteger(totalSize) ||
    totalSize < usedSize
  ) {
    return undefined;
  }

  const optionalCounter = (key: "embedderHeapUsedSize" | "backingStorageSize") => {
    const counter = value[key];
    if (counter === undefined || counter === null) return null;
    return typeof counter === "number" && Number.isSafeInteger(counter) && counter >= 0
      ? counter
      : undefined;
  };
  const embedderHeapUsedSize = optionalCounter("embedderHeapUsedSize");
  const backingStorageSize = optionalCounter("backingStorageSize");
  if (embedderHeapUsedSize === undefined || backingStorageSize === undefined) return undefined;

  return {
    usedSize,
    totalSize,
    embedderHeapUsedSize,
    backingStorageSize,
  };
}

/** Serializes public Runtime inspector calls and binds each window to one generation. */
export function createHeapInspectorSampler(
  call: InspectorCall,
  options: HeapInspectorOptions = {},
) {
  const clock = options.clock ?? systemSamplingClock;
  const maxPending = options.maxPending ?? 512;
  const readContext = options.readContext;
  if (typeof call !== "function") throw new TypeError("Inspector call transport is required");
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new TypeError("Inspector sample queue capacity must be a positive integer");
  }

  let currentGeneration: string | undefined;
  let closed = false;
  let responseBacklog = 0;
  let active: SampleJob | undefined;
  const seenGenerations = new Set<string>();
  let identity: IdentityState | undefined;
  let generationFailure: HeapInspectorGapError | undefined;
  const responseQueue: SampleJob[] = [];
  const intervalQueue: SampleJob[] = [];
  const pending = new Set<SampleJob>();
  const idleWaiters = new Set<() => void>();

  const idle = () => active === undefined && pending.size === 0;

  function notifyIdle() {
    if (!idle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function removeFromQueues(job: SampleJob) {
    for (const queue of [responseQueue, intervalQueue]) {
      const index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
    }
  }

  function detach(job: SampleJob) {
    job.cancelDeadline?.();
    job.cancelDeadline = null;
    if (job.abortHandler !== null) {
      job.context.signal?.removeEventListener("abort", job.abortHandler);
      job.abortHandler = null;
    }
  }

  function rejectJob(job: SampleJob, error: HeapInspectorGapError) {
    if (job.invalidatedReason === null) job.invalidatedReason = error;
    if (job.settled) return;
    job.settled = true;
    detach(job);
    pending.delete(job);
    removeFromQueues(job);
    job.reject(error);
    notifyIdle();
  }

  function invalidateJob(job: SampleJob, error: HeapInspectorGapError) {
    if (job.invalidatedReason === null) job.invalidatedReason = error;
    rejectJob(job, job.invalidatedReason);
  }

  function transitionToGeneration(next: string): HeapInspectorGapError | undefined {
    if (currentGeneration === next) return undefined;
    if (seenGenerations.has(next)) return new HeapInspectorGapError("stale-generation");

    currentGeneration = next;
    seenGenerations.add(next);
    identity = undefined;
    generationFailure = undefined;

    const changed = new HeapInspectorGapError("generation-changed");
    for (const job of pending) {
      if (job.context.generation !== next) invalidateJob(job, changed);
    }
    if (active !== undefined && active.context.generation !== next) {
      invalidateJob(active, changed);
    }
    return undefined;
  }

  function validateContext(context: HeapInspectorSampleContext): HeapInspectorGapError | undefined {
    if (
      context === null ||
      typeof context !== "object" ||
      typeof context.generation !== "string" ||
      context.generation.length === 0 ||
      (context.boundary !== undefined && typeof context.boundary !== "string") ||
      (context.deadlineAtMs !== undefined && !Number.isFinite(context.deadlineAtMs))
    ) {
      return new HeapInspectorGapError("invalid-context");
    }
    if (closed) return new HeapInspectorGapError("queue-closed");
    if (context.signal?.aborted) return new HeapInspectorGapError("aborted");
    if (context.deadlineAtMs !== undefined && clock.now() >= context.deadlineAtMs) {
      return new HeapInspectorGapError("deadline-expired");
    }
    return undefined;
  }

  function requestCanContinue(job: SampleJob): HeapInspectorGapError | undefined {
    if (job.invalidatedReason !== null) return job.invalidatedReason;
    if (job.context.generation !== currentGeneration) {
      return new HeapInspectorGapError("generation-changed");
    }
    if (closed) return new HeapInspectorGapError("queue-closed");
    if (job.context.signal?.aborted) return new HeapInspectorGapError("aborted");
    if (job.context.deadlineAtMs !== undefined && clock.now() >= job.context.deadlineAtMs) {
      return new HeapInspectorGapError("deadline-expired");
    }
    return undefined;
  }

  function assertCanContinue(job: SampleJob) {
    const error = requestCanContinue(job);
    if (error !== undefined) {
      invalidateJob(job, error);
      throw error;
    }
    if (generationFailure !== undefined) {
      throw new HeapInspectorGapError("generation-invalidated", {
        ...(generationFailure.method === null ? {} : { method: generationFailure.method }),
        cause: generationFailure,
      });
    }
  }

  function currentGenerationError(job: SampleJob): HeapInspectorGapError | undefined {
    if (closed) return new HeapInspectorGapError("queue-closed");
    if (job.context.generation !== currentGeneration)
      return new HeapInspectorGapError("generation-changed");
    return undefined;
  }

  async function identify(job: SampleJob): Promise<string> {
    if (identity?.status === "known") return identity.isolateId;
    if (identity?.status === "failed") {
      throw new HeapInspectorGapError("isolate-identity-unavailable", {
        method: "Runtime.getIsolateId",
        cause: identity.error,
      });
    }

    assertCanContinue(job);
    let result: unknown;
    try {
      result = await call("Runtime.getIsolateId");
    } catch (cause) {
      const stale = currentGenerationError(job);
      if (stale !== undefined) throw stale;
      const failure = new HeapInspectorGapError("isolate-identity-failed", {
        method: "Runtime.getIsolateId",
        cause,
      });
      identity = { status: "failed", error: failure };
      if (job.invalidatedReason !== null) throw job.invalidatedReason;
      throw failure;
    }

    const stale = currentGenerationError(job);
    if (stale !== undefined) throw stale;
    const isolateId = identityFrom(result);
    if (isolateId === undefined) {
      const failure = new HeapInspectorGapError("isolate-identity-invalid", {
        method: "Runtime.getIsolateId",
      });
      identity = { status: "failed", error: failure };
      if (job.invalidatedReason !== null) throw job.invalidatedReason;
      throw failure;
    }
    identity = { status: "known", isolateId };
    assertCanContinue(job);
    return isolateId;
  }

  async function readUsage(job: SampleJob, isolateId: string): Promise<HeapUsageObservation> {
    assertCanContinue(job);
    const before = readContext?.();
    const readStartedAtMs = clock.now();
    let result: unknown;
    try {
      result = await call("Runtime.getHeapUsage");
    } catch (cause) {
      const stale = currentGenerationError(job);
      if (stale !== undefined) throw stale;
      const failure = new HeapInspectorGapError("inspector-call-failed", {
        method: "Runtime.getHeapUsage",
        cause,
      });
      generationFailure = failure;
      if (job.invalidatedReason !== null) throw job.invalidatedReason;
      throw failure;
    }

    const readAcknowledgedAtMs = clock.now();
    const after = readContext?.();
    const stale = currentGenerationError(job);
    if (stale !== undefined) throw stale;
    const usage = usageFrom(result);
    if (usage === undefined) {
      const failure = new HeapInspectorGapError("invalid-heap-usage", {
        method: "Runtime.getHeapUsage",
      });
      generationFailure = failure;
      throw failure;
    }
    assertCanContinue(job);
    return {
      generation: job.context.generation,
      isolateId,
      ...usage,
      readStartedAtMs,
      readAcknowledgedAtMs,
      ...(readContext === undefined ? {} : { requestProgress: { before, after } }),
    };
  }

  async function runJob(job: SampleJob): Promise<HeapInspectorSample> {
    const isolateId = await identify(job);
    const observations: HeapUsageObservation[] = [];
    for (let index = 0; index < 3; index++) {
      observations.push(await readUsage(job, isolateId));
    }
    assertCanContinue(job);
    return {
      kind: job.kind,
      generation: job.context.generation,
      isolateId,
      boundary: job.context.boundary ?? null,
      granularity: "isolate-aggregate",
      measurement: "pre-gc-inspector-observations",
      gc: { method: null, acknowledged: false },
      observations,
    };
  }

  function pump() {
    if (active !== undefined || closed) {
      notifyIdle();
      return;
    }
    const job =
      responseQueue.shift() ?? (responseBacklog === 0 ? intervalQueue.shift() : undefined);
    if (job === undefined) {
      notifyIdle();
      return;
    }
    if (job.settled) {
      queueMicrotask(pump);
      return;
    }

    active = job;
    void runJob(job)
      .then(
        (sample) => {
          if (!job.settled) {
            job.settled = true;
            detach(job);
            pending.delete(job);
            job.resolve(sample);
          }
        },
        (error: unknown) => {
          const gap =
            error instanceof HeapInspectorGapError
              ? error
              : new HeapInspectorGapError("inspector-call-failed", { cause: error });
          rejectJob(job, gap);
        },
      )
      .finally(() => {
        if (active === job) active = undefined;
        notifyIdle();
        queueMicrotask(pump);
      });
  }

  function enqueue(
    kind: SampleJob["kind"],
    context: HeapInspectorSampleContext,
  ): Promise<HeapInspectorSample> {
    const invalid = validateContext(context);
    if (invalid !== undefined) return Promise.reject(invalid);
    const generationError = transitionToGeneration(context.generation);
    if (generationError !== undefined) return Promise.reject(generationError);
    if (pending.size >= maxPending) {
      return Promise.reject(new HeapInspectorGapError("queue-capacity"));
    }

    return new Promise<HeapInspectorSample>((resolve, reject) => {
      const job: SampleJob = {
        kind,
        context,
        resolve,
        reject,
        cancelDeadline: null,
        abortHandler: null,
        invalidatedReason: null,
        settled: false,
      };
      pending.add(job);
      (kind === "response" ? responseQueue : intervalQueue).push(job);

      if (context.signal !== undefined) {
        job.abortHandler = () => invalidateJob(job, new HeapInspectorGapError("aborted"));
        context.signal.addEventListener("abort", job.abortHandler, { once: true });
      }
      if (context.deadlineAtMs !== undefined) {
        job.cancelDeadline = clock.schedule(
          () => invalidateJob(job, new HeapInspectorGapError("deadline-expired")),
          Math.max(0, context.deadlineAtMs - clock.now()),
        );
      }

      if (context.signal?.aborted) invalidateJob(job, new HeapInspectorGapError("aborted"));
      else if (context.deadlineAtMs !== undefined && clock.now() >= context.deadlineAtMs) {
        invalidateJob(job, new HeapInspectorGapError("deadline-expired"));
      }
      queueMicrotask(pump);
    });
  }

  function waitForIdle() {
    if (idle()) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.add(resolve));
  }

  return {
    setResponseBacklog(pending: number) {
      if (!Number.isSafeInteger(pending) || pending < 0)
        throw new HeapInspectorGapError("invalid-context");
      responseBacklog = pending;
      queueMicrotask(pump);
    },
    sampleResponse(context: HeapInspectorSampleContext) {
      return enqueue("response", context);
    },
    sampleInterval(context: HeapInspectorSampleContext) {
      return enqueue("interval", context);
    },
    changeGeneration(generation: string) {
      if (typeof generation !== "string" || generation.length === 0) {
        throw new HeapInspectorGapError("invalid-context");
      }
      if (closed) throw new HeapInspectorGapError("queue-closed");
      const error = transitionToGeneration(generation);
      if (error !== undefined) throw error;
    },
    drain: waitForIdle,
    async close() {
      if (!closed) {
        closed = true;
        const error = new HeapInspectorGapError("queue-closed");
        for (const job of pending) invalidateJob(job, error);
      }
      await waitForIdle();
    },
  };
}
