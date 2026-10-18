import { expect, it, vi } from "vite-plus/test";

import {
  captureNativeInputTime,
  createNativeActionTimingPlatform,
  type NativeActionTimingPlatformOptions,
} from "./actionTimingPlatform";

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
}));

function makeAppState(initialState = "active") {
  let currentState: string | null = initialState;
  const listeners = new Set<(state: string) => void>();
  return {
    get currentState() {
      return currentState;
    },
    addEventListener(_event: "change", listener: (state: string) => void) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    setState(state: string) {
      currentState = state;
      for (const listener of listeners) listener(state);
    },
  };
}

function makeFrames() {
  let nextId = 0;
  const callbacks = new Map<number, (timestampMs: number) => void>();
  return {
    requestFrame: vi.fn((callback: (timestampMs: number) => void) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    }),
    cancelFrame: vi.fn((id: number) => {
      callbacks.delete(id);
    }),
    fire(id: number, timestampMs: number) {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      callback?.(timestampMs);
    },
    pendingCount: () => callbacks.size,
  };
}

function makeTimers() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const options: Pick<NativeActionTimingPlatformOptions, "setTimer" | "clearTimer"> = {
    setTimer: vi.fn((callback: () => void, _delayMs: number) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    }),
    clearTimer: vi.fn((timer: ReturnType<typeof setTimeout>) => {
      callbacks.delete(timer as unknown as number);
    }),
  };
  return {
    options,
    fireAll() {
      for (const [id, callback] of Array.from(callbacks)) {
        callbacks.delete(id);
        callback();
      }
    },
    pendingCount: () => callbacks.size,
  };
}

class FakePerformanceObserver {
  static readonly supportedEntryTypes = ["event"];
  static readonly instances: FakePerformanceObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: (list: { getEntries: () => readonly unknown[] }) => void) {
    FakePerformanceObserver.instances.push(this);
  }

  emit(entries: readonly unknown[]) {
    this.callback({ getEntries: () => entries });
  }
}

function makePlatform(options: Partial<NativeActionTimingPlatformOptions> = {}) {
  const appState = options.appState ?? makeAppState();
  const frames = makeFrames();
  const timers = makeTimers();
  const platform = createNativeActionTimingPlatform({
    now: () => 20,
    appState,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    ...timers.options,
    ...options,
  });
  return { platform, appState, frames, timers };
}

it("keeps only a valid native activation timestamp without substituting handler time", () => {
  expect(captureNativeInputTime({ nativeEvent: { timestamp: 83_100.25 } })).toBe(83_100.25);
  expect(captureNativeInputTime({ nativeEvent: {} })).toBeNull();
  expect(captureNativeInputTime({ nativeEvent: { timestamp: Number.NaN } })).toBeNull();
  expect(
    captureNativeInputTime({ nativeEvent: { timestamp: Number.POSITIVE_INFINITY } }),
  ).toBeNull();
  expect(captureNativeInputTime({ nativeEvent: { timestamp: -1 } })).toBeNull();
  expect(captureNativeInputTime(null)).toBeNull();
});

it("reports RN Event Timing only for an exact native input timestamp match", () => {
  FakePerformanceObserver.instances.length = 0;
  const { platform } = makePlatform({
    performanceObserver:
      FakePerformanceObserver as unknown as NativeActionTimingPlatformOptions["performanceObserver"],
  });
  const inputTimestampMs = 83_100.25;
  const onFrame = vi.fn();
  const unsubscribe = platform.observeEventTiming(inputTimestampMs, onFrame);
  expect(unsubscribe).toEqual(expect.any(Function));
  const observer = FakePerformanceObserver.instances[0]!;

  expect(observer.observe).toHaveBeenCalledWith({
    type: "event",
    buffered: true,
    durationThreshold: 16,
  });
  observer.emit([
    { entryType: "event", startTime: inputTimestampMs + 0.01, duration: 21 },
    { entryType: "mark", startTime: inputTimestampMs, duration: 2 },
  ]);
  expect(onFrame).not.toHaveBeenCalled();

  observer.emit([{ entryType: "event", startTime: inputTimestampMs, duration: 12.5 }]);
  expect(onFrame).toHaveBeenCalledOnce();
  expect(onFrame).toHaveBeenCalledWith(12.5);
  expect(observer.disconnect).toHaveBeenCalledOnce();
  unsubscribe?.();
  platform.dispose();
});

it("does not subscribe when RN does not advertise Event Timing support", () => {
  FakePerformanceObserver.instances.length = 0;
  const unsupportedObserver = class extends FakePerformanceObserver {
    static override readonly supportedEntryTypes = ["mark", "measure"];
  };
  const { platform } = makePlatform({
    performanceObserver:
      unsupportedObserver as unknown as NativeActionTimingPlatformOptions["performanceObserver"],
  });

  const onFrame = vi.fn();
  expect(platform.observeEventTiming(10, onFrame)).toBeNull();
  expect(unsupportedObserver.instances).toHaveLength(0);
  platform.dispose();
});

it("returns null for invalid, background, and capacity-limited subscriptions", () => {
  FakePerformanceObserver.instances.length = 0;
  const { platform } = makePlatform({
    maxPendingEventTimings: 1,
    performanceObserver:
      FakePerformanceObserver as unknown as NativeActionTimingPlatformOptions["performanceObserver"],
  });
  const onFrame = vi.fn();

  expect(platform.observeEventTiming(Number.NaN, onFrame)).toBeNull();
  const cancel = platform.observeEventTiming(10, onFrame);
  expect(cancel).toEqual(expect.any(Function));
  expect(platform.observeEventTiming(11, onFrame)).toBeNull();
  cancel?.();
  expect(platform.observeEventTiming(11, onFrame)).toEqual(expect.any(Function));
  platform.dispose();

  FakePerformanceObserver.instances.length = 0;
  const background = makePlatform({
    appState: makeAppState("background"),
    performanceObserver:
      FakePerformanceObserver as unknown as NativeActionTimingPlatformOptions["performanceObserver"],
  });
  expect(background.platform.observeEventTiming(12, onFrame)).toBeNull();
  expect(FakePerformanceObserver.instances).toHaveLength(0);
  background.platform.dispose();
});

it("returns null when starting the native event observer fails", () => {
  const failedObserver = {
    supportedEntryTypes: ["event"],
    disconnect: vi.fn(),
    observe: vi.fn(() => {
      throw new Error("observer startup failed");
    }),
  };
  class ThrowingPerformanceObserver {
    static readonly supportedEntryTypes = ["event"];

    constructor(_callback: (list: { getEntries(): readonly unknown[] }) => void) {}

    observe = failedObserver.observe;
    disconnect = failedObserver.disconnect;
  }
  const { platform } = makePlatform({
    performanceObserver:
      ThrowingPerformanceObserver as unknown as NativeActionTimingPlatformOptions["performanceObserver"],
  });

  expect(platform.observeEventTiming(10, vi.fn())).toBeNull();
  expect(failedObserver.observe).toHaveBeenCalledOnce();
  expect(failedObserver.disconnect).toHaveBeenCalledOnce();
  platform.dispose();
});

it("bounds a native event subscription to 30 seconds", () => {
  FakePerformanceObserver.instances.length = 0;
  const defaults = makePlatform({
    performanceObserver:
      FakePerformanceObserver as unknown as NativeActionTimingPlatformOptions["performanceObserver"],
  });
  const defaultCancel = defaults.platform.observeEventTiming(9, vi.fn());
  expect(defaults.timers.options.setTimer).toHaveBeenCalledWith(expect.any(Function), 30_000);
  defaultCancel?.();
  defaults.platform.dispose();

  const capped = makePlatform({
    eventTimingTimeoutMs: 60_000,
    performanceObserver:
      FakePerformanceObserver as unknown as NativeActionTimingPlatformOptions["performanceObserver"],
  });
  const cancel = capped.platform.observeEventTiming(10, vi.fn());
  expect(capped.timers.options.setTimer).toHaveBeenCalledWith(expect.any(Function), 30_000);
  cancel?.();
  capped.platform.dispose();
});

it("does not attach one RN event entry to two activations with the same timestamp", () => {
  FakePerformanceObserver.instances.length = 0;
  const { platform } = makePlatform({
    performanceObserver:
      FakePerformanceObserver as unknown as NativeActionTimingPlatformOptions["performanceObserver"],
  });
  const firstActivation = vi.fn();
  const secondActivation = vi.fn();
  const cancel = platform.observeEventTiming(10, firstActivation);
  expect(cancel).toEqual(expect.any(Function));
  expect(platform.observeEventTiming(10, secondActivation)).toBeNull();
  FakePerformanceObserver.instances[0]!.emit([{ entryType: "event", startTime: 10, duration: 24 }]);

  expect(firstActivation).toHaveBeenCalledOnce();
  expect(secondActivation).not.toHaveBeenCalled();
  platform.dispose();
});

it("expires unmatched native events and disconnects the observer", () => {
  FakePerformanceObserver.instances.length = 0;
  const { platform, timers } = makePlatform({
    performanceObserver:
      FakePerformanceObserver as unknown as NativeActionTimingPlatformOptions["performanceObserver"],
    eventTimingTimeoutMs: 100,
  });
  const onFrame = vi.fn();
  expect(platform.observeEventTiming(10, onFrame)).toEqual(expect.any(Function));
  const observer = FakePerformanceObserver.instances[0]!;

  timers.fireAll();
  observer.emit([{ entryType: "event", startTime: 10, duration: 30 }]);

  expect(onFrame).not.toHaveBeenCalled();
  expect(observer.disconnect).toHaveBeenCalledOnce();
  platform.dispose();
});

it("cancels frame/event observers on background but still fires scheduled deadlines", () => {
  FakePerformanceObserver.instances.length = 0;
  const appState = makeAppState();
  const { platform, frames, timers } = makePlatform({
    appState,
    performanceObserver:
      FakePerformanceObserver as unknown as NativeActionTimingPlatformOptions["performanceObserver"],
  });
  const onFrame = vi.fn();
  const frameCancel = platform.afterCommit(onFrame);
  platform.schedule(onFrame, 100);
  expect(platform.observeEventTiming(10, onFrame)).toEqual(expect.any(Function));
  const foregroundChange = vi.fn();
  const unsubscribeForeground = platform.subscribeForeground?.(foregroundChange);
  const observer = FakePerformanceObserver.instances[0]!;

  appState.setState("background");
  frames.fire(1, 40);
  observer.emit([{ entryType: "event", startTime: 10, duration: 30 }]);

  expect(platform.foreground()).toBe(false);
  expect(frames.pendingCount()).toBe(0);
  expect(timers.pendingCount()).toBe(1);
  expect(observer.disconnect).toHaveBeenCalledOnce();
  expect(onFrame).not.toHaveBeenCalled();
  expect(foregroundChange).toHaveBeenCalledWith(false);
  timers.fireAll();
  expect(onFrame).toHaveBeenCalledOnce();
  frameCancel();
  unsubscribeForeground?.();
  platform.dispose();
});

it("labels the scheduled native frame as an estimate, never as presented", () => {
  const { platform, frames } = makePlatform();
  const onFrame = vi.fn();
  platform.afterCommit(onFrame);
  frames.fire(1, 42.5);

  expect(onFrame).toHaveBeenCalledWith({ timestampMs: 42.5, method: "native_frame_estimate" });
  expect(onFrame.mock.calls[0]?.[0].method).not.toBe("native_presented");
  platform.dispose();
});

it("reports only the current commit when no frame callback exists", () => {
  const { platform } = makePlatform({ requestFrame: null });
  const onFrame = vi.fn();
  platform.afterCommit(onFrame);

  expect(onFrame).toHaveBeenCalledWith({ timestampMs: 20, method: "commit_only" });
  platform.dispose();
});
