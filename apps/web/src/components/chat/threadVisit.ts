/**
 * signalbox: what ChatView's visit effect sends and when it may skip one.
 *
 * ChatView stays mounted across thread switches, so its dedupe used to keep
 * the last visit's key for good: reopening a thread whose `updatedAt` hadn't
 * moved skipped the visit, and a visit that never landed was never retried.
 * The server's watermark then stayed behind the failed run and its Failed pill
 * never cleared. The dedupe now forgets on entering another thread and when a
 * visit fails.
 */

/** A visit covers the thread up to its latest change, and at least its latest run's end. */
export function visitStampFor(thread: {
  readonly updatedAt: string;
  readonly latestRun?: { readonly completedAt: string | null } | null;
}): string {
  const completedAt = thread.latestRun?.completedAt ?? null;
  if (completedAt === null) return thread.updatedAt;
  const updated = Date.parse(thread.updatedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(completed) && !(updated >= completed) ? completedAt : thread.updatedAt;
}

export function createVisitDedupe() {
  let last: { readonly thread: string; readonly key: string } | null = null;
  return {
    /** True when this exact visit was already sent while this thread stayed open. */
    isDuplicate(thread: string, key: string): boolean {
      if (last !== null && last.thread !== thread) last = null;
      return last?.key === key;
    },
    sent(thread: string, key: string) {
      last = { thread, key };
    },
    /** The visit didn't land; the next run of the effect sends it again. */
    failed(key: string) {
      if (last?.key === key) last = null;
    },
  };
}
