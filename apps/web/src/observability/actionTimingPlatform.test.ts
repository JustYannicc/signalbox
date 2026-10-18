import { describe, expect, it } from "vite-plus/test";

import {
  createActionTimingPlatform,
  type ActionTimingPlatformHost,
  type EventTimingEntryLike,
} from "./actionTimingPlatform";

interface FakeObserverList {
  getEntries(): readonly EventTimingEntryLike[];
}

class FakePerformanceObserver {
  static supportedEntryTypes: string[] = ["event"];
  static instances: FakePerformanceObserver[] = [];
  static shouldThrowOnObserve = false;
  static shouldThrowOnGetEntries = false;

  readonly options: unknown[] = [];
  disconnected = false;

  constructor(private readonly callback: (list: FakeObserverList) => void) {
    FakePerformanceObserver.instances.push(this);
  }

  observe(options: unknown): void {
    this.options.push(options);
    if (FakePerformanceObserver.shouldThrowOnObserve) throw new Error("observer unavailable");
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(entries: readonly EventTimingEntryLike[]): void {
    this.callback({
      getEntries: () => {
        if (FakePerformanceObserver.shouldThrowOnGetEntries)
          throw new Error("observer delivery failed");
        return entries;
      },
    });
  }

  static reset(): void {
    FakePerformanceObserver.supportedEntryTypes = ["event"];
    FakePerformanceObserver.instances = [];
    FakePerformanceObserver.shouldThrowOnObserve = false;
    FakePerformanceObserver.shouldThrowOnGetEntries = false;
  }
}

function makeHost() {
  let nowMs = 500;
  let visibilityState: DocumentVisibilityState = "visible";
  let nextHandle = 1;
  const frames = new Map<number, (timestampMs: number) => void>();
  const timers = new Map<number, () => void>();
  const visibilityListeners = new Set<() => void>();
  let throwOnRequestAnimationFrame = false;

  const host: ActionTimingPlatformHost = {
    performance: {
      now: () => nowMs,
      timeOrigin: 1_700_000_000_000,
    },
    document: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type, listener) => visibilityListeners.add(listener),
      removeEventListener: (_type, listener) => visibilityListeners.delete(listener),
    },
    PerformanceObserver: FakePerformanceObserver,
    requestAnimationFrame: (callback) => {
      if (throwOnRequestAnimationFrame) throw new Error("animation frames unavailable");
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle) => frames.delete(handle),
    setTimeout: (callback) => {
      const handle = nextHandle++;
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle) => timers.delete(handle as number),
  };

  return {
    host,
    frames,
    timers,
    visibilityListeners,
    setNow(timestampMs: number) {
      nowMs = timestampMs;
    },
    setThrowOnRequestAnimationFrame(shouldThrow: boolean) {
      throwOnRequestAnimationFrame = shouldThrow;
    },
    setVisibility(state: DocumentVisibilityState) {
      visibilityState = state;
      for (const listener of Array.from(visibilityListeners)) listener();
    },
    runNextFrame(timestampMs: number) {
      const [handle, callback] = frames.entries().next().value ?? [];
      if (handle === undefined || callback === undefined) throw new Error("no queued frame");
      frames.delete(handle);
      callback(timestampMs);
    },
    runTimers() {
      for (const [handle, callback] of Array.from(timers)) {
        timers.delete(handle);
        callback();
      }
    },
  };
}

function eventTiming(startTime: number, duration: number, interactionId = 1): EventTimingEntryLike {
  return { entryType: "event", startTime, duration, interactionId };
}

describe("browser action timing platform", () => {
  it("matches Event Timing against the original queued input timestamp", () => {
    FakePerformanceObserver.reset();
    const fake = makeHost();
    const platform = createActionTimingPlatform(fake.host);
    const timestamp = platform.captureInput({
      nativeEvent: { timeStamp: fake.host.performance.timeOrigin + 120.25 },
    });
    const samples: number[] = [];

    expect(timestamp).toBe(120.25);
    const cancel = platform.observeEventTiming(timestamp!, (elapsedMs) => samples.push(elapsedMs));
    expect(cancel).not.toBeNull();
    fake.setNow(8_000);
    FakePerformanceObserver.instances[0]!.emit([eventTiming(120.25, 24)]);

    expect(samples).toEqual([24]);
    expect(FakePerformanceObserver.instances[0]!.options).toEqual([
      { type: "event", buffered: true, durationThreshold: 16 },
    ]);
    cancel?.();
    platform.dispose();
  });

  it("keeps one largest duration for entries in the same interaction", () => {
    FakePerformanceObserver.reset();
    const platform = createActionTimingPlatform(makeHost().host);
    const samples: number[] = [];
    platform.observeEventTiming(100, (elapsedMs) => samples.push(elapsedMs));
    const observer = FakePerformanceObserver.instances[0]!;

    observer.emit([eventTiming(100, 19, 9)]);
    observer.emit([eventTiming(101, 31, 9), eventTiming(102, 23, 10)]);

    expect(samples).toEqual([19, 31]);
    platform.dispose();
  });

  it("bounds outstanding Event Timing correlations at 64 inputs", () => {
    FakePerformanceObserver.reset();
    const platform = createActionTimingPlatform(makeHost().host);
    let firstSampleCount = 0;
    const cancellations = Array.from({ length: 65 }, (_, index) =>
      platform.observeEventTiming(100 + index * 100, () => {
        if (index === 0) firstSampleCount += 1;
      }),
    );

    FakePerformanceObserver.instances[0]!.emit([eventTiming(100, 30)]);

    expect(firstSampleCount).toBe(1);
    expect(cancellations.slice(0, 64).every((cancel) => cancel !== null)).toBe(true);
    expect(cancellations[64]).toBeNull();
    platform.dispose();
  });

  it("uses two animation frames for the visible commit estimate", () => {
    FakePerformanceObserver.reset();
    const fake = makeHost();
    const platform = createActionTimingPlatform(fake.host);
    let commit: { timestampMs: number; method: string } | undefined;

    platform.afterCommit((frame) => {
      commit = frame;
    });
    expect(fake.frames.size).toBe(1);
    fake.runNextFrame(501);
    expect(fake.frames.size).toBe(1);
    expect(commit).toBeUndefined();
    fake.runNextFrame(517);

    expect(commit).toEqual({ timestampMs: 517, method: "browser_frame_estimate" });
    expect(fake.frames.size).toBe(0);
    platform.dispose();
  });

  it("keeps Event Timing observation open for entries delivered after the commit frames", () => {
    FakePerformanceObserver.reset();
    const fake = makeHost();
    const platform = createActionTimingPlatform(fake.host);
    const samples: number[] = [];
    let committed = false;
    const cancel = platform.observeEventTiming(100, (elapsedMs) => samples.push(elapsedMs));

    platform.afterCommit(() => {
      committed = true;
    });
    fake.runNextFrame(501);
    fake.runNextFrame(517);
    expect(committed).toBe(true);
    expect(samples).toEqual([]);
    expect(cancel).not.toBeNull();

    FakePerformanceObserver.instances[0]!.emit([eventTiming(100, 43)]);

    expect(samples).toEqual([43]);
    cancel?.();
    platform.dispose();
  });

  it("does not fabricate a sample below the observer threshold or for an unmatched input", () => {
    FakePerformanceObserver.reset();
    const platform = createActionTimingPlatform(makeHost().host);
    const samples: number[] = [];
    platform.observeEventTiming(100, (elapsedMs) => samples.push(elapsedMs));
    FakePerformanceObserver.instances[0]!.emit([eventTiming(100, 15.99), eventTiming(200, 40)]);

    expect(samples).toEqual([]);
    platform.dispose();
  });

  it("clears pending timing and frame work when the document goes hidden", () => {
    FakePerformanceObserver.reset();
    const fake = makeHost();
    const platform = createActionTimingPlatform(fake.host);
    const samples: number[] = [];
    let commit: { timestampMs: number; method: string } | undefined;
    platform.observeEventTiming(100, (elapsedMs) => samples.push(elapsedMs));
    platform.afterCommit((frame) => {
      commit = frame;
    });

    fake.setVisibility("hidden");
    FakePerformanceObserver.instances[0]!.emit([eventTiming(100, 40)]);

    expect(commit).toEqual({ timestampMs: 500, method: "commit_only" });
    expect(fake.frames.size).toBe(0);
    expect(fake.visibilityListeners.size).toBe(0);
    expect(samples).toEqual([]);
    expect(FakePerformanceObserver.instances[0]!.disconnected).toBe(true);
    platform.dispose();
  });

  it("notifies foreground subscribers when visibility changes in either direction", () => {
    FakePerformanceObserver.reset();
    const fake = makeHost();
    const platform = createActionTimingPlatform(fake.host);
    const changes: boolean[] = [];
    const unsubscribe = platform.subscribeForeground((isForeground) => changes.push(isForeground));

    fake.setVisibility("hidden");
    fake.setVisibility("visible");
    unsubscribe();

    expect(changes).toEqual([false, true]);
    expect(fake.visibilityListeners.size).toBe(0);
    platform.dispose();
  });

  it("treats observer construction failures as unavailable and releases partial observers", () => {
    FakePerformanceObserver.reset();
    FakePerformanceObserver.shouldThrowOnObserve = true;
    const platform = createActionTimingPlatform(makeHost().host);
    const samples: number[] = [];

    expect(platform.observeEventTiming(100, (elapsedMs) => samples.push(elapsedMs))).toBeNull();
    expect(FakePerformanceObserver.instances[0]!.disconnected).toBe(true);
    expect(samples).toEqual([]);
    platform.dispose();
  });

  it("cancels all scheduled callbacks and observations on disposal", () => {
    FakePerformanceObserver.reset();
    const fake = makeHost();
    const platform = createActionTimingPlatform(fake.host);
    let callbackCount = 0;
    platform.schedule(() => callbackCount++, 10);
    platform.afterCommit(() => callbackCount++);
    platform.observeEventTiming(100, () => callbackCount++);

    platform.dispose();
    fake.runTimers();
    FakePerformanceObserver.instances[0]!.emit([eventTiming(100, 40)]);

    expect(callbackCount).toBe(0);
    expect(fake.frames.size).toBe(0);
    expect(fake.timers.size).toBe(0);
    expect(FakePerformanceObserver.instances[0]!.disconnected).toBe(true);
  });

  it("returns null when Event Timing is unsupported, the input is invalid, or the page is hidden", () => {
    FakePerformanceObserver.reset();
    const fake = makeHost();
    const platform = createActionTimingPlatform(fake.host);
    FakePerformanceObserver.supportedEntryTypes = [];
    expect(platform.observeEventTiming(100, () => undefined)).toBeNull();

    FakePerformanceObserver.supportedEntryTypes = ["event"];
    expect(platform.observeEventTiming(Number.NaN, () => undefined)).toBeNull();
    fake.setVisibility("hidden");
    expect(platform.observeEventTiming(100, () => undefined)).toBeNull();
    expect(FakePerformanceObserver.instances).toHaveLength(0);
    platform.dispose();
    expect(platform.observeEventTiming(100, () => undefined)).toBeNull();
  });

  it("contains animation frame and observer delivery errors", () => {
    FakePerformanceObserver.reset();
    const fake = makeHost();
    const platform = createActionTimingPlatform(fake.host);
    fake.setThrowOnRequestAnimationFrame(true);
    let commit: { timestampMs: number; method: string } | undefined;

    expect(() =>
      platform.afterCommit((frame) => {
        commit = frame;
      }),
    ).not.toThrow();
    expect(commit?.method).toBe("commit_only");

    fake.setThrowOnRequestAnimationFrame(false);
    expect(
      platform.observeEventTiming(100, () => {
        throw new Error("consumer callback failed");
      }),
    ).not.toBeNull();
    FakePerformanceObserver.shouldThrowOnGetEntries = true;
    expect(() => FakePerformanceObserver.instances[0]!.emit([eventTiming(100, 40)])).not.toThrow();
    FakePerformanceObserver.shouldThrowOnGetEntries = false;
    expect(() => FakePerformanceObserver.instances[0]!.emit([eventTiming(100, 41)])).not.toThrow();
    platform.dispose();
  });
});
