import type { ClientActionTiming } from "@t3tools/contracts/clientActionTiming";

const DEFAULT_MAX_QUEUED = 128;
const MAX_CONFIGURED_QUEUE = 4_096;
const MAX_BATCH_SIZE = 16;
const DEFAULT_FLUSH_DELAY_MS = 1_000;
const MAX_FLUSH_DELAY_MS = 60_000;

export interface ActionTimingQueueOptions {
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly send: (samples: ReadonlyArray<ClientActionTiming>) => Promise<unknown>;
  readonly enabled: () => boolean;
  readonly maxQueued?: number;
  readonly flushDelayMs?: number;
}

export interface ActionTimingQueueStats {
  readonly queued: number;
  readonly dropped: number;
  readonly failed: number;
  readonly sent: number;
}

interface ScheduledFlush {
  readonly generation: number;
  cancel?: () => void;
}

interface ActiveFlush {
  promise: Promise<void>;
}

/** Buffers timing samples without letting exporter failures affect client actions. */
export function createActionTimingQueue(options: ActionTimingQueueOptions) {
  const maxQueued = boundedInteger(options.maxQueued, DEFAULT_MAX_QUEUED, MAX_CONFIGURED_QUEUE);
  const flushDelayMs = boundedDelay(options.flushDelayMs);
  let generation = 0;
  let disposed = false;
  let queued: ClientActionTiming[] = [];
  let scheduledFlush: ScheduledFlush | undefined;
  let activeFlush: ActiveFlush | undefined;
  let dropped = 0;
  let failed = 0;
  let sent = 0;

  function hasConsent(): boolean {
    try {
      return options.enabled();
    } catch {
      return false;
    }
  }

  function cancelTimer(): void {
    const timer = scheduledFlush;
    scheduledFlush = undefined;
    try {
      timer?.cancel?.();
    } catch {
      // A timer adapter cannot interrupt the action that added a sample.
    }
  }

  function clear(): void {
    generation += 1;
    cancelTimer();
    dropped += queued.length;
    queued = [];
  }

  function scheduleNextFlush(): void {
    if (
      disposed ||
      queued.length === 0 ||
      activeFlush !== undefined ||
      scheduledFlush !== undefined
    ) {
      return;
    }

    const timer: ScheduledFlush = { generation };
    scheduledFlush = timer;
    try {
      timer.cancel = options.schedule(() => {
        if (scheduledFlush === timer) scheduledFlush = undefined;
        void Promise.resolve()
          .then(() => {
            if (disposed || generation !== timer.generation) return;
            if (!hasConsent()) {
              clear();
              return;
            }
            return flush();
          })
          .catch(() => undefined);
      }, flushDelayMs);
    } catch {
      if (scheduledFlush === timer) scheduledFlush = undefined;
    }
  }

  function startFlush(): Promise<void> {
    const flushGeneration = generation;
    let remaining = queued.length;
    const record: ActiveFlush = {
      promise: Promise.resolve(),
    };
    activeFlush = record;

    record.promise = Promise.resolve()
      .then(async () => {
        while (queued.length > 0 && remaining > 0) {
          if (disposed || generation !== flushGeneration) break;
          if (!hasConsent()) {
            clear();
            break;
          }

          const batch = queued.splice(0, Math.min(MAX_BATCH_SIZE, remaining));
          remaining -= batch.length;
          try {
            await options.send(batch);
            sent += batch.length;
          } catch {
            failed += batch.length;
            dropped += batch.length;
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (activeFlush === record) activeFlush = undefined;
        if (!disposed && queued.length > 0) {
          if (!hasConsent()) clear();
          else scheduleNextFlush();
        }
      });

    return record.promise;
  }

  function flush(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!hasConsent()) {
      clear();
      return Promise.resolve();
    }

    cancelTimer();
    if (activeFlush !== undefined) {
      const current = activeFlush;
      return current.promise.then(() => {
        if (disposed) return;
        if (!hasConsent()) {
          clear();
          return;
        }
        return queued.length > 0 ? flush() : undefined;
      });
    }
    if (queued.length === 0) return Promise.resolve();
    return startFlush();
  }

  function enqueue(sample: ClientActionTiming): void {
    if (disposed) return;
    if (!hasConsent()) {
      clear();
      return;
    }

    if (queued.length >= maxQueued) {
      queued.shift();
      dropped += 1;
    }
    queued.push(sample);
    scheduleNextFlush();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clear();
  }

  function stats(): ActionTimingQueueStats {
    return { queued: queued.length, dropped, failed, sent };
  }

  return { enqueue, flush, clear, dispose, stats };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function boundedDelay(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_FLUSH_DELAY_MS;
  return Math.max(0, Math.min(MAX_FLUSH_DELAY_MS, Math.floor(value)));
}
