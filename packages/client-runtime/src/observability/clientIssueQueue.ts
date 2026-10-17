import type { ClientIssue } from "@t3tools/contracts/clientIssues";

export interface ClientIssueQueueSender {
  readonly send: (issue: ClientIssue) => Promise<void | "discarded">;
  readonly scheduleRetry?: (
    callback: () => Promise<ClientIssueFlushResult> | undefined,
    delayMs: number,
  ) => () => void;
}

export interface QueuedClientIssue extends ClientIssueQueueSender {
  readonly event: ClientIssue;
  readonly dedupeKey?: string;
}

export interface ClientIssueFlushResult {
  readonly sent: number;
  readonly failed: number;
  readonly pending: number;
  readonly dropped: number;
}

export interface ClientIssueReportingStats {
  readonly pending: number;
  readonly dropped: number;
}

interface QueuedIssue extends QueuedClientIssue {
  readonly dedupeSignature?: string;
}

interface ActiveFlush {
  readonly generation: number;
  promise: Promise<ClientIssueFlushResult>;
}

const MAX_PENDING_ISSUES = 100;
const MAX_DEDUPE_KEYS = 256;
const MAX_TIMER_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const RETRY_COOLDOWN_MS = 30_000;

/** Keeps client issue delivery bounded and fences work on account changes. */
export function createClientIssueQueue() {
  let generation = 0;
  let pending: QueuedIssue[] = [];
  let activeSending: QueuedIssue | null = null;
  let activeFlush: ActiveFlush | null = null;
  let retryCount = 0;
  let retryAfter = 0;
  let cancelRetry: (() => void) | undefined;
  let droppedCount = 0;
  let lastFailedDestinations = new Set<string | null>();
  const lastStateByKey = new Map<string, string>();

  const reset = (): void => {
    generation += 1;
    cancelScheduledRetry();
    pending = [];
    activeSending = null;
    activeFlush = null;
    retryCount = 0;
    retryAfter = 0;
    droppedCount = 0;
    lastFailedDestinations.clear();
    lastStateByKey.clear();
  };

  const enqueue = (queued: QueuedClientIssue): boolean => {
    const dedupeSignature =
      queued.dedupeKey === undefined ? undefined : stateSignature(queued.event);
    if (
      queued.dedupeKey !== undefined &&
      dedupeSignature !== undefined &&
      lastStateByKey.get(queued.dedupeKey) === dedupeSignature
    ) {
      return false;
    }
    if (queued.dedupeKey !== undefined && dedupeSignature !== undefined) {
      rememberState(queued.dedupeKey, dedupeSignature);
    }

    const entry: QueuedIssue = {
      ...queued,
      ...(dedupeSignature === undefined ? {} : { dedupeSignature }),
    };
    if (pending.length >= MAX_PENDING_ISSUES) {
      const sendingIndex = activeSending === null ? -1 : pending.indexOf(activeSending);
      const dropIndex = sendingIndex === 0 ? 1 : 0;
      const [dropped] = pending.splice(dropIndex, 1);
      if (dropped !== undefined) {
        droppedCount += 1;
        forgetStateIfCurrent(dropped);
      }
    }
    pending.push(entry);
    void flushAutomatically();
    return true;
  };

  /** Explicitly retries retained reports, for example after focus or reconnect. */
  const flush = (): Promise<ClientIssueFlushResult> => {
    if (activeFlush?.generation === generation) return activeFlush.promise;
    cancelScheduledRetry();
    retryCount = 0;
    retryAfter = 0;
    return startFlush();
  };

  const stats = (): ClientIssueReportingStats => ({
    pending: pending.length,
    dropped: droppedCount,
  });

  function stateSignature(issue: ClientIssue): string {
    return JSON.stringify({
      code: issue.code,
      severity: issue.severity,
      source: issue.source,
      client: issue.client,
      release: issue.release,
      threadId: issue.threadId,
      folderId: issue.folderId,
      environmentId: issue.environmentId,
      ...(issue.method === undefined ? {} : { method: issue.method }),
      ...(issue.durationMs === undefined ? {} : { durationMs: issue.durationMs }),
    });
  }

  function rememberState(key: string, signature: string): void {
    lastStateByKey.delete(key);
    lastStateByKey.set(key, signature);
    if (lastStateByKey.size > MAX_DEDUPE_KEYS) {
      const oldestKey = lastStateByKey.keys().next().value;
      if (oldestKey !== undefined) lastStateByKey.delete(oldestKey);
    }
  }

  function forgetStateIfCurrent(queued: QueuedIssue): void {
    if (
      queued.dedupeKey !== undefined &&
      queued.dedupeSignature !== undefined &&
      lastStateByKey.get(queued.dedupeKey) === queued.dedupeSignature
    ) {
      lastStateByKey.delete(queued.dedupeKey);
    }
  }

  function cancelScheduledRetry(): void {
    const cancel = cancelRetry;
    cancelRetry = undefined;
    try {
      cancel?.();
    } catch {
      // A timer adapter cannot interrupt reporting or configuration.
    }
  }

  function scheduleNextRetry(): void {
    if (cancelRetry !== undefined || pending.length === 0) return;
    if (retryCount >= MAX_TIMER_RETRIES) {
      if (retryAfter === 0) retryAfter = performance.now() + RETRY_COOLDOWN_MS;
      return;
    }
    const delayMs = RETRY_DELAYS_MS[retryCount]!;
    const scheduledGeneration = generation;
    retryCount += 1;
    const schedule = pending.find((entry) => entry.scheduleRetry !== undefined)?.scheduleRetry;
    if (schedule === undefined) {
      retryCount = MAX_TIMER_RETRIES;
      retryAfter = performance.now() + RETRY_COOLDOWN_MS;
      return;
    }
    try {
      cancelRetry = schedule(() => {
        if (generation !== scheduledGeneration) return;
        cancelRetry = undefined;
        return startFlush();
      }, delayMs);
    } catch {
      retryCount = MAX_TIMER_RETRIES;
      retryAfter = performance.now() + RETRY_COOLDOWN_MS;
    }
  }

  function flushAutomatically(): Promise<ClientIssueFlushResult> {
    if (activeFlush?.generation === generation) return activeFlush.promise;
    if (
      cancelRetry !== undefined ||
      (retryCount >= MAX_TIMER_RETRIES && performance.now() < retryAfter)
    ) {
      return startFlush(lastFailedDestinations);
    }
    if (retryCount >= MAX_TIMER_RETRIES) {
      retryCount = 0;
      retryAfter = 0;
    }
    return startFlush();
  }

  function startFlush(
    skippedDestinations: ReadonlySet<string | null> = new Set(),
  ): Promise<ClientIssueFlushResult> {
    if (activeFlush?.generation === generation) return activeFlush.promise;
    if (!pending.some((entry) => !skippedDestinations.has(entry.event.environmentId))) {
      return Promise.resolve(currentFlushResult(0, 0));
    }

    const flushGeneration = generation;
    const record: ActiveFlush = {
      generation: flushGeneration,
      promise: Promise.resolve(currentFlushResult(0, 0)),
    };
    let sent = 0;
    let failed = 0;
    const run = async (): Promise<ClientIssueFlushResult> => {
      const failedDestinations = new Set(skippedDestinations);
      const attempted = new Set<QueuedIssue>();
      let attemptCount = 0;
      while (attemptCount < MAX_PENDING_ISSUES) {
        if (generation !== flushGeneration) break;
        const queued = pending.find(
          (candidate) =>
            !attempted.has(candidate) && !failedDestinations.has(candidate.event.environmentId),
        );
        if (queued === undefined) break;
        attempted.add(queued);
        attemptCount += 1;

        activeSending = queued;
        try {
          const result = await queued.send(queued.event);
          if (generation !== flushGeneration) break;
          removeQueued(queued);
          if (result === "discarded") {
            droppedCount += 1;
            forgetStateIfCurrent(queued);
          } else {
            sent += 1;
          }
        } catch {
          if (generation !== flushGeneration) break;
          failed += 1;
          failedDestinations.add(queued.event.environmentId);
        } finally {
          if (activeSending === queued) activeSending = null;
        }
      }

      if (generation === flushGeneration) {
        lastFailedDestinations = new Set(
          pending
            .filter((entry) => failedDestinations.has(entry.event.environmentId))
            .map((entry) => entry.event.environmentId),
        );
        if (failed > 0 && pending.length > 0) {
          scheduleNextRetry();
        } else if (pending.length === 0) {
          retryCount = 0;
          retryAfter = 0;
          cancelScheduledRetry();
        }
      }
      return currentFlushResult(sent, failed);
    };

    record.promise = run()
      .catch(() => {
        if (generation === flushGeneration) {
          failed += 1;
          scheduleNextRetry();
        }
        return currentFlushResult(sent, failed);
      })
      .finally(() => {
        if (activeFlush === record) activeFlush = null;
        if (generation === flushGeneration && pending.length > 0) {
          void flushAutomatically();
        }
      });
    activeFlush = record;
    return record.promise;
  }

  function removeQueued(queued: QueuedIssue): void {
    const index = pending.indexOf(queued);
    if (index >= 0) pending.splice(index, 1);
  }

  function currentFlushResult(sent: number, failed: number): ClientIssueFlushResult {
    return { sent, failed, pending: pending.length, dropped: droppedCount };
  }

  return { enqueue, flush, reset, stats, clearState: (key: string) => lastStateByKey.delete(key) };
}
