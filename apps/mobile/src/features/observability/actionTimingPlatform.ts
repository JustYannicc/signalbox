import { AppState } from "react-native";
import type {
  ActionTimingFrame,
  ActionTimingPlatform,
} from "@t3tools/client-runtime/observability/action-timing";

export interface NativeActionTimingPlatform extends ActionTimingPlatform {
  /**
   * Correlates one RN Event Timing entry with the exact native activation timestamp.
   * RN reports a native mount milestone here, not proof of display presentation.
   */
  readonly observeEventTiming: (
    inputTimestampMs: number,
    callback: (elapsedMs: number) => void,
  ) => (() => void) | null;
  readonly subscribeForeground?: (callback: (foreground: boolean) => void) => () => void;
  readonly dispose: () => void;
}

interface EventTimingEntry {
  readonly entryType?: string;
  readonly startTime?: number;
  readonly duration?: number;
}

interface EventTimingObserver {
  observe(options: {
    readonly type: "event";
    readonly buffered: true;
    readonly durationThreshold: 16;
  }): void;
  disconnect(): void;
}

interface EventTimingObserverConstructor {
  new (
    callback: (list: { getEntries(): readonly EventTimingEntry[] }) => void,
  ): EventTimingObserver;
  readonly supportedEntryTypes?: readonly string[];
}

interface NativeAppState {
  readonly currentState: string | null;
  addEventListener(event: "change", listener: (state: string) => void): { remove: () => void };
}

export interface NativeActionTimingPlatformOptions {
  readonly now?: () => number;
  readonly appState?: NativeAppState;
  readonly requestFrame?: ((callback: (timestampMs: number) => void) => number | null) | null;
  readonly cancelFrame?: ((frameId: number) => void) | null;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly performanceObserver?: EventTimingObserverConstructor | null;
  readonly eventTimingTimeoutMs?: number;
  readonly maxPendingEventTimings?: number;
}

// Keep observations available for the shared recorder's 30-second activation deadline.
const DEFAULT_EVENT_TIMING_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_EVENT_TIMINGS = 32;
const MAX_EVENT_TIMING_TIMEOUT_MS = 30_000;
const MAX_PENDING_EVENT_TIMINGS = 128;

/**
 * Keep the native event timestamp as-is. Falling back to `now()` here would erase
 * the delay between the OS input and JavaScript receiving the activation.
 */
export function captureNativeInputTime(input: unknown): number | null {
  if (typeof input !== "object" || input === null) return null;
  const nativeEvent = (input as { nativeEvent?: { timestamp?: unknown } }).nativeEvent;
  const timestamp = nativeEvent?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0
    ? timestamp
    : null;
}

export function createNativeActionTimingPlatform(
  options: NativeActionTimingPlatformOptions = {},
): NativeActionTimingPlatform {
  const appState = options.appState ?? (AppState as unknown as NativeAppState);
  const globals = globalThis as typeof globalThis & {
    PerformanceObserver?: EventTimingObserverConstructor;
    requestAnimationFrame?: (callback: (timestampMs: number) => void) => number;
    cancelAnimationFrame?: (frameId: number) => void;
    performance?: { now?: () => number };
  };
  const now =
    options.now ??
    (() => {
      const performanceObject = globals.performance;
      return typeof performanceObject?.now === "function" ? performanceObject.now() : Date.now();
    });
  const requestFrame =
    options.requestFrame === undefined
      ? globals.requestAnimationFrame?.bind(globalThis)
      : options.requestFrame;
  const cancelFrame =
    options.cancelFrame === undefined
      ? globals.cancelAnimationFrame?.bind(globalThis)
      : options.cancelFrame;
  const setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
  const requestedTimeoutMs = options.eventTimingTimeoutMs ?? DEFAULT_EVENT_TIMING_TIMEOUT_MS;
  const eventTimingTimeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.min(MAX_EVENT_TIMING_TIMEOUT_MS, Math.max(0, requestedTimeoutMs))
    : DEFAULT_EVENT_TIMING_TIMEOUT_MS;
  const requestedPendingLimit = options.maxPendingEventTimings ?? DEFAULT_MAX_PENDING_EVENT_TIMINGS;
  const maxPendingEventTimings = Number.isSafeInteger(requestedPendingLimit)
    ? Math.min(MAX_PENDING_EVENT_TIMINGS, Math.max(1, requestedPendingLimit))
    : DEFAULT_MAX_PENDING_EVENT_TIMINGS;

  let disposed = false;
  let appIsForeground = appState.currentState === "active";
  let observer: EventTimingObserver | undefined;
  const pendingCancellations = new Set<() => void>();
  const backgroundCancellations = new Set<() => void>();
  const foregroundListeners = new Set<(foreground: boolean) => void>();
  const eventTimingSubscriptions = new Map<
    number,
    { readonly callback: (elapsedMs: number) => void; readonly cancelExpiry: () => void }
  >();

  const foreground = () => !disposed && appIsForeground;

  const notify = (callback: (frame: ActionTimingFrame) => void, frame: ActionTimingFrame) => {
    try {
      callback(frame);
    } catch {
      // Timing callbacks must stay off the application error path.
    }
  };

  const notifyElapsed = (callback: (elapsedMs: number) => void, elapsedMs: number) => {
    try {
      callback(elapsedMs);
    } catch {
      // Timing is observational; a consumer failure must not escape input handling.
    }
  };

  const trackCancellation = (cancel: () => void, cancelOnBackground = false) => {
    let pending = true;
    const tracked = () => {
      if (!pending) return;
      pending = false;
      pendingCancellations.delete(tracked);
      backgroundCancellations.delete(tracked);
      cancel();
    };
    pendingCancellations.add(tracked);
    if (cancelOnBackground) backgroundCancellations.add(tracked);
    return tracked;
  };

  const disconnectObserverWhenIdle = () => {
    if (eventTimingSubscriptions.size !== 0) return;
    observer?.disconnect();
    observer = undefined;
  };

  const removeEventTimingSubscription = (inputTimestampMs: number) => {
    const subscription = eventTimingSubscriptions.get(inputTimestampMs);
    if (!subscription) return;
    eventTimingSubscriptions.delete(inputTimestampMs);
    subscription.cancelExpiry();
    disconnectObserverWhenIdle();
  };

  const dispatchEventTimingEntries = (entries: readonly EventTimingEntry[]) => {
    if (!foreground()) return;
    for (const entry of entries) {
      if (
        entry.entryType !== "event" ||
        typeof entry.startTime !== "number" ||
        typeof entry.duration !== "number" ||
        !Number.isFinite(entry.startTime) ||
        !Number.isFinite(entry.duration) ||
        entry.duration < 0
      ) {
        continue;
      }

      const subscription = eventTimingSubscriptions.get(entry.startTime);
      if (!subscription) continue;
      if (!Number.isFinite(entry.startTime + entry.duration)) continue;
      removeEventTimingSubscription(entry.startTime);
      notifyElapsed(subscription.callback, entry.duration);
    }
  };

  const observerConstructor = () => {
    const Observer =
      options.performanceObserver === undefined
        ? globals.PerformanceObserver
        : options.performanceObserver;
    return Observer?.supportedEntryTypes?.includes("event") ? Observer : undefined;
  };

  const ensureObserver = (Observer: EventTimingObserverConstructor) => {
    if (observer) return true;

    let nextObserver: EventTimingObserver | undefined;
    try {
      nextObserver = new Observer((list) => dispatchEventTimingEntries(list.getEntries()));
      observer = nextObserver;
      nextObserver.observe({ type: "event", buffered: true, durationThreshold: 16 });
      return observer === nextObserver;
    } catch {
      try {
        nextObserver?.disconnect();
      } catch {
        // Cleanup failure must not escape event observation startup.
      }
      if (observer === nextObserver) observer = undefined;
      return false;
    }
  };

  const schedule: ActionTimingPlatform["schedule"] = (callback, delayMs) => {
    if (disposed) return () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = trackCancellation(() => {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    });
    try {
      timer = setTimer(
        () => {
          cancel();
          try {
            callback();
          } catch {
            // Timing callbacks must stay off the application error path.
          }
        },
        Math.max(0, delayMs),
      );
    } catch (error) {
      cancel();
      throw error;
    }
    return cancel;
  };

  const afterCommit: ActionTimingPlatform["afterCommit"] = (callback) => {
    if (!foreground()) return () => {};
    if (!requestFrame) {
      notify(callback, { timestampMs: now(), method: "commit_only" });
      return () => {};
    }

    let frameId: number | null = null;
    const cancel = trackCancellation(() => {
      if (frameId !== null) cancelFrame?.(frameId);
      frameId = null;
    }, true);
    try {
      frameId = requestFrame((timestampMs) => {
        cancel();
        if (!foreground()) return;
        notify(callback, {
          timestampMs: Number.isFinite(timestampMs) ? timestampMs : now(),
          method: "native_frame_estimate",
        });
      });
      if (frameId === null) {
        cancel();
        if (foreground()) notify(callback, { timestampMs: now(), method: "commit_only" });
      }
    } catch {
      cancel();
      if (foreground()) notify(callback, { timestampMs: now(), method: "commit_only" });
    }
    return cancel;
  };

  const appStateSubscription = appState.addEventListener("change", (state) => {
    const wasForeground = appIsForeground;
    appIsForeground = state === "active";
    if (wasForeground !== appIsForeground) {
      for (const listener of foregroundListeners) {
        try {
          listener(appIsForeground);
        } catch {
          // Lifecycle observation must not change app-state handling.
        }
      }
    }
    if (appIsForeground) return;
    for (const cancel of Array.from(backgroundCancellations)) cancel();
    for (const inputTimestampMs of Array.from(eventTimingSubscriptions.keys())) {
      removeEventTimingSubscription(inputTimestampMs);
    }
    observer?.disconnect();
    observer = undefined;
  });

  return {
    eventTimingMethod: "rn_event_mount",
    now,
    foreground,
    schedule,
    afterCommit,
    observeEventTiming(inputTimestampMs, callback) {
      if (
        !foreground() ||
        !Number.isFinite(inputTimestampMs) ||
        inputTimestampMs < 0 ||
        eventTimingSubscriptions.size >= maxPendingEventTimings ||
        eventTimingSubscriptions.has(inputTimestampMs)
      ) {
        return null;
      }
      const Observer = observerConstructor();
      if (!Observer) return null;

      let cancelExpiry = () => {};
      eventTimingSubscriptions.set(inputTimestampMs, {
        callback,
        cancelExpiry: () => cancelExpiry(),
      });
      try {
        cancelExpiry = schedule(
          () => removeEventTimingSubscription(inputTimestampMs),
          eventTimingTimeoutMs,
        );
      } catch {
        removeEventTimingSubscription(inputTimestampMs);
        return null;
      }
      if (!eventTimingSubscriptions.has(inputTimestampMs)) return null;
      if (!ensureObserver(Observer) || !eventTimingSubscriptions.has(inputTimestampMs)) {
        removeEventTimingSubscription(inputTimestampMs);
        return null;
      }
      return () => removeEventTimingSubscription(inputTimestampMs);
    },
    subscribeForeground(callback) {
      if (disposed) return () => {};
      foregroundListeners.add(callback);
      return () => foregroundListeners.delete(callback);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancel of Array.from(pendingCancellations)) cancel();
      eventTimingSubscriptions.clear();
      foregroundListeners.clear();
      observer?.disconnect();
      observer = undefined;
      appStateSubscription.remove();
    },
  };
}
