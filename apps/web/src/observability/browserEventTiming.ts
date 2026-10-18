export interface EventTimingEntryLike {
  readonly entryType?: string;
  readonly startTime: number;
  readonly duration: number;
  readonly interactionId?: number;
}

interface EventTimingObserverLike {
  observe(options: {
    readonly type: "event";
    readonly buffered: true;
    readonly durationThreshold: 16;
  }): void;
  disconnect(): void;
}

export interface EventTimingPerformanceObserverConstructor {
  new (
    callback: (list: { getEntries(): readonly EventTimingEntryLike[] }) => void,
  ): EventTimingObserverLike;
  readonly supportedEntryTypes?: readonly string[];
}

export interface BrowserEventTimingHost {
  readonly PerformanceObserver?: EventTimingPerformanceObserverConstructor | undefined;
  readonly foreground: () => boolean;
  readonly subscribeForeground: (callback: (foreground: boolean) => void) => () => void;
}

interface PendingEventTiming {
  readonly inputTimestampMs: number;
  readonly callback: (elapsedMs: number) => void;
  interactionId?: number;
  largestDurationMs: number;
  active: boolean;
  cancelForeground?: () => void;
  cancelObservation?: () => void;
}

interface RecentEventTiming {
  readonly interactionId: number;
  readonly startTime: number;
  readonly duration: number;
}

const EVENT_DURATION_THRESHOLD_MS = 16;
const EVENT_TIMESTAMP_TOLERANCE_MS = 1;
const MAX_PENDING_EVENT_TIMINGS = 64;

function isFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

export function createBrowserEventTimingCorrelator(host: BrowserEventTimingHost) {
  const pendingEventTimings: PendingEventTiming[] = [];
  const recentEventTimings: RecentEventTiming[] = [];
  const activeCancellations = new Set<() => void>();
  let observer: EventTimingObserverLike | null = null;
  let observerUnavailable = false;
  let disposed = false;

  function registerCancellation(cancel: () => void): () => void {
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      activeCancellations.delete(cancelAndRelease);
    };
    const cancelAndRelease = () => {
      if (!active) return;
      release();
      try {
        cancel();
      } catch {
        // Cancellation is best effort; telemetry must not affect the action.
      }
    };
    activeCancellations.add(cancelAndRelease);
    return cancelAndRelease;
  }

  function disconnectWhenIdle(): void {
    if (pendingEventTimings.length !== 0 || observer === null) return;
    try {
      observer.disconnect();
    } catch {
      // Observer cleanup is best effort.
    }
    observer = null;
  }

  function removePending(record: PendingEventTiming): void {
    if (!record.active) return;
    record.active = false;
    record.cancelForeground?.();
    record.cancelObservation?.();
    const index = pendingEventTimings.indexOf(record);
    if (index >= 0) pendingEventTimings.splice(index, 1);
    disconnectWhenIdle();
  }

  function notify(record: PendingEventTiming, durationMs: number): void {
    if (!record.active || durationMs <= record.largestDurationMs) return;
    record.largestDurationMs = durationMs;
    try {
      record.callback(durationMs);
    } catch {
      // An observer callback must not escape into the browser event loop.
    }
  }

  function rememberEventTiming(entry: EventTimingEntryLike, interactionId: number): void {
    recentEventTimings.push({
      interactionId,
      startTime: entry.startTime,
      duration: entry.duration,
    });
    if (recentEventTimings.length > MAX_PENDING_EVENT_TIMINGS) recentEventTimings.shift();
  }

  function largestInteractionDuration(interactionId: number): number {
    return recentEventTimings.reduce(
      (largest, entry) =>
        entry.interactionId === interactionId ? Math.max(largest, entry.duration) : largest,
      0,
    );
  }

  function receiveEventTimingEntries(entries: readonly EventTimingEntryLike[]): void {
    const matchedEntries: { entry: EventTimingEntryLike; interactionId: number }[] = [];
    for (const entry of entries) {
      const interactionId = entry.interactionId;
      if (
        (entry.entryType !== undefined && entry.entryType !== "event") ||
        !isFiniteNumber(entry.startTime) ||
        !isFiniteNumber(entry.duration) ||
        entry.duration < EVENT_DURATION_THRESHOLD_MS ||
        !isFiniteNumber(interactionId) ||
        interactionId <= 0
      ) {
        continue;
      }

      rememberEventTiming(entry, interactionId);
      matchedEntries.push({ entry, interactionId });
    }

    for (const record of Array.from(pendingEventTimings)) {
      if (record.interactionId !== undefined) {
        notify(record, largestInteractionDuration(record.interactionId));
        continue;
      }

      let closestEntry: (typeof matchedEntries)[number] | undefined;
      let closestDistance = EVENT_TIMESTAMP_TOLERANCE_MS + Number.EPSILON;
      for (const match of matchedEntries) {
        const distance = Math.abs(record.inputTimestampMs - match.entry.startTime);
        if (distance <= EVENT_TIMESTAMP_TOLERANCE_MS && distance < closestDistance) {
          closestEntry = match;
          closestDistance = distance;
        }
      }
      if (closestEntry) {
        record.interactionId = closestEntry.interactionId;
        notify(record, largestInteractionDuration(closestEntry.interactionId));
      }
    }
  }

  function ensureObserver(): boolean {
    if (observer !== null) return true;
    if (observerUnavailable || disposed) return false;

    let Observer: EventTimingPerformanceObserverConstructor | undefined;
    try {
      Observer = host.PerformanceObserver;
      if (!Observer?.supportedEntryTypes?.includes("event")) return false;
    } catch {
      observerUnavailable = true;
      return false;
    }

    let nextObserver: EventTimingObserverLike | undefined;
    try {
      nextObserver = new Observer((list) => {
        try {
          receiveEventTimingEntries(list.getEntries());
        } catch {
          // PerformanceObserver delivery is optional telemetry.
        }
      });
      nextObserver.observe({
        type: "event",
        buffered: true,
        durationThreshold: EVENT_DURATION_THRESHOLD_MS,
      });
      observer = nextObserver;
      return true;
    } catch {
      try {
        nextObserver?.disconnect();
      } catch {
        // A partially armed observer must not escape through the input path.
      }
      observerUnavailable = true;
      return false;
    }
  }

  return {
    observe(inputTimestampMs: number, callback: (elapsedMs: number) => void): (() => void) | null {
      if (
        disposed ||
        !Number.isFinite(inputTimestampMs) ||
        inputTimestampMs < 0 ||
        pendingEventTimings.length >= MAX_PENDING_EVENT_TIMINGS ||
        !host.foreground()
      ) {
        return null;
      }

      const record: PendingEventTiming = {
        inputTimestampMs,
        callback,
        largestDurationMs: 0,
        active: true,
      };
      pendingEventTimings.push(record);
      if (!ensureObserver()) {
        removePending(record);
        return null;
      }

      let bufferedEventTiming: RecentEventTiming | undefined;
      let closestDistance = EVENT_TIMESTAMP_TOLERANCE_MS + Number.EPSILON;
      for (const item of recentEventTimings) {
        const distance = Math.abs(record.inputTimestampMs - item.startTime);
        if (distance <= EVENT_TIMESTAMP_TOLERANCE_MS && distance < closestDistance) {
          bufferedEventTiming = item;
          closestDistance = distance;
        }
      }
      if (bufferedEventTiming) {
        record.interactionId = bufferedEventTiming.interactionId;
        notify(record, largestInteractionDuration(bufferedEventTiming.interactionId));
      }
      try {
        record.cancelForeground = host.subscribeForeground((foreground) => {
          if (!foreground) removePending(record);
        });
      } catch {
        removePending(record);
        return null;
      }

      const cancelObservation = registerCancellation(() => removePending(record));
      record.cancelObservation = cancelObservation;
      return cancelObservation;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const cancel of Array.from(activeCancellations)) cancel();
      pendingEventTimings.length = 0;
      recentEventTimings.length = 0;
      try {
        observer?.disconnect();
      } catch {
        // Observer cleanup is best effort.
      }
      observer = null;
    },
  };
}
