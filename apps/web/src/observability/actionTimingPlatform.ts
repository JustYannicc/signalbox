import type { ActionTimingPlatform } from "@t3tools/client-runtime/observability/action-timing";
import {
  createBrowserEventTimingCorrelator,
  type EventTimingPerformanceObserverConstructor,
} from "./browserEventTiming";

export type { EventTimingEntryLike } from "./browserEventTiming";

export interface ActionTimingInputEvent {
  readonly timeStamp?: number;
  readonly nativeEvent?: ActionTimingInputEvent;
}

export interface ActionTimingPlatformHost {
  readonly performance: {
    now(): number;
    readonly timeOrigin: number;
  };
  readonly document?: {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
  };
  readonly PerformanceObserver?: EventTimingPerformanceObserverConstructor;
  readonly requestAnimationFrame?: (callback: (timestampMs: number) => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface BrowserActionTimingPlatform extends ActionTimingPlatform {
  /** Capture this synchronously in the input handler, before dispatching or queueing work. */
  captureInput(event: ActionTimingInputEvent): number | null;
  /** Observe Event Timing separately from the state-commit presentation estimate. */
  observeEventTiming(
    inputTimestampMs: number,
    callback: (elapsedMs: number) => void,
  ): (() => void) | null;
  subscribeForeground(callback: (foreground: boolean) => void): () => void;
  dispose(): void;
}

function defaultHost(): ActionTimingPlatformHost {
  const browser = globalThis as typeof globalThis & {
    readonly document?: Document;
    readonly PerformanceObserver?: EventTimingPerformanceObserverConstructor;
  };

  return {
    performance: globalThis.performance,
    ...(browser.document ? { document: browser.document } : {}),
    ...(browser.PerformanceObserver ? { PerformanceObserver: browser.PerformanceObserver } : {}),
    ...(globalThis.requestAnimationFrame
      ? { requestAnimationFrame: globalThis.requestAnimationFrame.bind(globalThis) }
      : {}),
    ...(globalThis.cancelAnimationFrame
      ? { cancelAnimationFrame: globalThis.cancelAnimationFrame.bind(globalThis) }
      : {}),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function isFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function normalizeInputTimestamp(
  host: ActionTimingPlatformHost,
  timestampMs: number,
): number | null {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) return null;

  // Older engines exposed epoch-based Event.timeStamp values; PerformanceEntry.startTime is
  // relative to the performance time origin.
  if (timestampMs <= 1_000_000_000_000) return timestampMs;
  const timeOrigin = host.performance.timeOrigin;
  const relativeTimestamp = timestampMs - timeOrigin;
  return Number.isFinite(timeOrigin) && relativeTimestamp >= 0 ? relativeTimestamp : null;
}

function nativeInputEvent(event: ActionTimingInputEvent): ActionTimingInputEvent {
  return event.nativeEvent ?? event;
}

export function createActionTimingPlatform(
  suppliedHost?: ActionTimingPlatformHost,
): BrowserActionTimingPlatform {
  const host = suppliedHost ?? defaultHost();
  const activeCancellations = new Set<() => void>();
  const foregroundSubscribers = new Set<(foreground: boolean) => void>();
  const foreground = () => {
    try {
      return host.document ? host.document.visibilityState === "visible" : true;
    } catch {
      return false;
    }
  };
  let lastForeground = foreground();
  let visibilityListener: (() => void) | null = null;
  let disposed = false;

  function subscribeForeground(callback: (foreground: boolean) => void): () => void {
    if (disposed) return () => undefined;
    lastForeground = foreground();
    foregroundSubscribers.add(callback);
    let document: ActionTimingPlatformHost["document"];
    try {
      document = host.document;
    } catch {
      document = undefined;
    }
    if (foregroundSubscribers.size === 1 && document) {
      visibilityListener = () => {
        const current = foreground();
        if (current === lastForeground) return;
        lastForeground = current;
        for (const subscriber of Array.from(foregroundSubscribers)) {
          try {
            subscriber(current);
          } catch {
            // A subscriber must not interrupt visibility handling.
          }
        }
      };
      try {
        document.addEventListener("visibilitychange", visibilityListener);
      } catch {
        visibilityListener = null;
      }
    }
    const cancel = registerCancellation(() => {
      foregroundSubscribers.delete(callback);
      if (foregroundSubscribers.size === 0 && visibilityListener) {
        try {
          host.document?.removeEventListener("visibilitychange", visibilityListener);
        } catch {
          // Visibility cleanup is best effort; telemetry must not affect the action.
        }
        visibilityListener = null;
      }
    });
    return cancel;
  }

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

  const eventTiming = createBrowserEventTimingCorrelator({
    get PerformanceObserver() {
      return host.PerformanceObserver;
    },
    foreground,
    subscribeForeground,
  });

  function finishAfterCommit(
    callback: Parameters<ActionTimingPlatform["afterCommit"]>[0],
    timestampMs: number,
    method: "browser_frame_estimate" | "commit_only",
  ): void {
    if (disposed) return;
    try {
      callback({ timestampMs, method });
    } catch {
      // UI lifecycle callbacks must not be interrupted by telemetry consumers.
    }
  }

  const platform: BrowserActionTimingPlatform = {
    eventTimingMethod: "browser_event_timing",
    now: () => {
      try {
        return host.performance.now();
      } catch {
        return Number.NaN;
      }
    },
    foreground,
    subscribeForeground,

    schedule(callback, delayMs) {
      if (disposed) return () => undefined;
      let cancel: () => void = () => undefined;
      const handle = host.setTimeout(() => {
        cancel();
        if (!disposed) callback();
      }, delayMs);
      cancel = registerCancellation(() => host.clearTimeout(handle));
      return cancel;
    },

    afterCommit(callback) {
      if (disposed) return () => undefined;
      let requestFrame: ActionTimingPlatformHost["requestAnimationFrame"];
      let cancelFrame: ActionTimingPlatformHost["cancelAnimationFrame"];
      try {
        requestFrame = host.requestAnimationFrame;
        cancelFrame = host.cancelAnimationFrame;
      } catch {
        finishAfterCommit(callback, platform.now(), "commit_only");
        return () => undefined;
      }
      if (!foreground() || !requestFrame || !cancelFrame) {
        finishAfterCommit(callback, platform.now(), "commit_only");
        return () => undefined;
      }

      let firstFrame: number | undefined;
      let secondFrame: number | undefined;
      let cancelForeground: () => void = () => undefined;
      let cancel: () => void = () => undefined;
      let completed = false;

      const cleanup = () => {
        completed = true;
        try {
          if (firstFrame !== undefined) cancelFrame(firstFrame);
          if (secondFrame !== undefined) cancelFrame(secondFrame);
        } catch {
          // Frame cancellation is best effort.
        }
        cancelForeground();
      };
      const complete = (timestampMs: number, method: "browser_frame_estimate" | "commit_only") => {
        if (completed) return;
        completed = true;
        cancel();
        finishAfterCommit(callback, timestampMs, method);
      };

      cancel = registerCancellation(cleanup);
      try {
        cancelForeground = subscribeForeground((isForeground) => {
          if (!isForeground) complete(platform.now(), "commit_only");
        });
      } catch {
        cancelForeground = () => undefined;
      }
      try {
        firstFrame = requestFrame(() => {
          if (disposed) return;
          if (!foreground()) {
            complete(platform.now(), "commit_only");
            return;
          }
          try {
            secondFrame = requestFrame((timestampMs) => {
              complete(timestampMs, foreground() ? "browser_frame_estimate" : "commit_only");
            });
          } catch {
            complete(platform.now(), "commit_only");
          }
        });
      } catch {
        complete(platform.now(), "commit_only");
      }
      return cancel;
    },

    captureInput(event) {
      if (disposed) return null;
      try {
        const input = nativeInputEvent(event);
        const timestamp = isFiniteNumber(input.timeStamp) ? input.timeStamp : event.timeStamp;
        return isFiniteNumber(timestamp) ? normalizeInputTimestamp(host, timestamp) : null;
      } catch {
        return null;
      }
    },

    observeEventTiming(inputTimestampMs, callback) {
      if (disposed) return null;
      let normalizedTimestamp: number | null;
      try {
        normalizedTimestamp = normalizeInputTimestamp(host, inputTimestampMs);
      } catch {
        return null;
      }
      if (normalizedTimestamp === null || !foreground()) return null;
      try {
        return eventTiming.observe(normalizedTimestamp, callback);
      } catch {
        return null;
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancel of Array.from(activeCancellations)) cancel();
      eventTiming.dispose();
    },
  };

  return platform;
}
