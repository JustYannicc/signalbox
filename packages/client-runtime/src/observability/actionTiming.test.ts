import { describe, expect, it } from "vite-plus/test";
import type { ClientActionTiming } from "@t3tools/contracts/clientActionTiming";
import {
  createActionTimingRecorder,
  type ActionTimingFrame,
  type ActionTimingPlatform,
} from "@t3tools/client-runtime/observability/action-timing";

type FrameCallback = (frame: ActionTimingFrame) => void;

interface ScheduledCallback {
  readonly callback: () => void;
  readonly dueMs: number;
  active: boolean;
}

interface FrameRegistration {
  readonly callback: FrameCallback;
  active: boolean;
}

interface EventTimingRegistration {
  readonly inputTimestampMs: number;
  readonly callback: (elapsedMs: number) => void;
  active: boolean;
}

class FakeActionTimingPlatform {
  nowMs = 1_000;
  isForeground = true;
  readonly timers: ScheduledCallback[] = [];
  readonly frames: FrameRegistration[] = [];
  readonly eventTiming: EventTimingRegistration[] = [];
  readonly foregroundListeners: Array<{
    readonly callback: (foreground: boolean) => void;
    active: boolean;
  }> = [];

  asPlatform(withEventTiming = false): ActionTimingPlatform {
    return {
      now: () => this.nowMs,
      foreground: () => this.isForeground,
      schedule: (callback, delayMs) => {
        const timer = {
          callback,
          dueMs: this.nowMs + Math.max(0, delayMs),
          active: true,
        };
        this.timers.push(timer);
        return () => {
          timer.active = false;
        };
      },
      afterCommit: (callback) => {
        const frame = { callback, active: true };
        this.frames.push(frame);
        return () => {
          frame.active = false;
        };
      },
      ...(withEventTiming
        ? {
            observeEventTiming: (
              inputTimestampMs: number,
              callback: (elapsedMs: number) => void,
            ) => {
              const observation = { inputTimestampMs, callback, active: true };
              this.eventTiming.push(observation);
              return () => {
                observation.active = false;
              };
            },
            eventTimingMethod: "browser_event_timing" as const,
          }
        : {}),
      subscribeForeground: (callback) => {
        const listener = { callback, active: true };
        this.foregroundListeners.push(listener);
        return () => {
          listener.active = false;
        };
      },
    };
  }

  advanceBy(deltaMs: number): void {
    const targetMs = this.nowMs + deltaMs;
    while (true) {
      const next = this.timers
        .filter((timer) => timer.active && timer.dueMs <= targetMs)
        .sort((left, right) => left.dueMs - right.dueMs)[0];
      if (!next) break;
      next.active = false;
      this.nowMs = next.dueMs;
      next.callback();
    }
    this.nowMs = targetMs;
  }

  setForeground(foreground: boolean): void {
    this.isForeground = foreground;
    for (const listener of this.foregroundListeners) {
      if (listener.active) listener.callback(foreground);
    }
  }

  returnFrame(
    frame: FrameRegistration,
    timestampMs: number,
    method: ActionTimingFrame["method"] = "browser_frame_estimate",
    evenIfCancelled = false,
  ): void {
    if (!frame.active && !evenIfCancelled) return;
    frame.active = false;
    frame.callback({ timestampMs, method });
  }

  recordEventTiming(elapsedMs: number): void {
    for (const observation of this.eventTiming) {
      if (observation.active) observation.callback(elapsedMs);
    }
  }
}

function createHarness(
  options: {
    readonly withEventTiming?: boolean;
    readonly enabled?: () => boolean;
    readonly send?: (samples: ReadonlyArray<ClientActionTiming>) => Promise<unknown>;
    readonly decoratePlatform?: (platform: ActionTimingPlatform) => ActionTimingPlatform;
  } = {},
) {
  const platform = new FakeActionTimingPlatform();
  const sent: ClientActionTiming[] = [];
  let enabled = true;
  const recorder = createActionTimingRecorder({
    platform:
      options.decoratePlatform?.(platform.asPlatform(options.withEventTiming)) ??
      platform.asPlatform(options.withEventTiming),
    context: () => ({
      client: "web",
      os: "macos",
      device: "computer",
      release: "development",
      connection: "online",
      mode: "cloud",
    }),
    enabled: options.enabled ?? (() => enabled),
    correlationId: () => "a".repeat(32),
    send: options.send ?? (async (samples) => sent.push(...samples)),
  });

  return {
    platform,
    recorder,
    sent,
    setEnabled(value: boolean) {
      enabled = value;
    },
  };
}

function activation(
  platform: FakeActionTimingPlatform,
  inputTimeMs = platform.nowMs,
  token: object = {},
) {
  return {
    action: "thread.send" as const,
    entryPoint: "click" as const,
    inputTimeMs,
    activation: token,
    path: "optimistic" as const,
  };
}

async function flush(recorder: ReturnType<typeof createActionTimingRecorder>): Promise<void> {
  await recorder.flush();
}

describe("action timing recorder", () => {
  it.each(["now", "schedule", "afterCommit", "foreground"] as const)(
    "contains a throwing %s platform adapter",
    async (method) => {
      const { platform, recorder, sent } = createHarness({
        decoratePlatform: (original) => ({
          ...original,
          [method]: () => {
            throw new Error("adapter unavailable");
          },
        }),
      });
      expect(() => {
        const handle = recorder.begin(activation(platform));
        handle.committed("both");
        handle.acknowledged();
        handle.finish("rejected");
      }).not.toThrow();
      await flush(recorder);
      expect(recorder.stats().active).toBe(0);
      expect(sent).toHaveLength(0);
      expect(
        method === "now" ? recorder.stats().invalidInputs : recorder.stats().droppedActivations,
      ).toBe(1);
    },
  );
  it("keeps input time and measures handler, frame, acknowledgement, convergence, and completion separately", async () => {
    const { platform, recorder, sent } = createHarness();
    const inputTimeMs = platform.nowMs;
    platform.advanceBy(7);
    const handle = recorder.begin(activation(platform, inputTimeMs));

    platform.advanceBy(3);
    handle.acknowledged();
    platform.advanceBy(4);
    handle.committed("both");
    const frame = platform.frames[0]!;
    platform.advanceBy(3);
    platform.returnFrame(frame, inputTimeMs + 17, "native_presented");
    platform.advanceBy(2);
    handle.converged();
    platform.advanceBy(6);
    handle.completed();
    handle.finish("success");

    await flush(recorder);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      inputTimeMs,
      handlerDelayMs: 7,
      feedback: { elapsedMs: 17, method: "native_presented" },
      desiredState: { elapsedMs: 17, method: "native_presented" },
      acknowledgementMs: 10,
      convergenceMs: 19,
      completionMs: 25,
      outcome: "success",
    });
  });

  it("records fast frame feedback without Event Timing support", async () => {
    const { platform, recorder, sent } = createHarness();
    const inputTimeMs = platform.nowMs;
    const handle = recorder.begin(activation(platform, inputTimeMs));
    handle.committed("feedback");
    platform.returnFrame(platform.frames[0]!, inputTimeMs + 9);
    handle.finish("success");

    await flush(recorder);

    expect(sent[0]).toMatchObject({
      feedback: { elapsedMs: 9, method: "browser_frame_estimate" },
      eventTimingMs: null,
      eventTimingMethod: null,
      eventTimingStatus: "unavailable",
      outcome: "success",
    });
  });

  it("keeps the largest Event Timing duration separate from frame feedback", async () => {
    const { platform, recorder, sent } = createHarness({ withEventTiming: true });
    const inputTimeMs = platform.nowMs;
    const handle = recorder.begin(activation(platform, inputTimeMs));
    handle.committed("feedback");
    platform.returnFrame(platform.frames[0]!, inputTimeMs + 6);
    platform.recordEventTiming(4);
    platform.recordEventTiming(19);
    platform.recordEventTiming(11);
    handle.finish("success");

    platform.advanceBy(1_000);
    await flush(recorder);

    expect(platform.eventTiming[0]?.inputTimestampMs).toBe(inputTimeMs);
    expect(sent[0]).toMatchObject({
      feedback: { elapsedMs: 6 },
      eventTimingMs: 19,
      eventTimingMethod: "browser_event_timing",
      eventTimingStatus: "observed",
    });
  });

  it("retains late Event Timing delivery after meaningful feedback finishes", async () => {
    const { platform, recorder, sent } = createHarness({ withEventTiming: true });
    const handle = recorder.begin(activation(platform));
    handle.committed("feedback");
    platform.returnFrame(platform.frames[0]!, platform.nowMs + 8);
    handle.finish("success");
    await flush(recorder);
    expect(sent).toHaveLength(0);
    platform.advanceBy(30);
    platform.recordEventTiming(48);
    platform.advanceBy(970);
    await flush(recorder);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ eventTimingMs: 48, eventTimingStatus: "observed" });
  });

  it("keeps foreground feedback when the app backgrounds during telemetry grace", async () => {
    const { platform, recorder, sent } = createHarness({ withEventTiming: true });
    const handle = recorder.begin(activation(platform));
    handle.committed("both");
    platform.returnFrame(platform.frames[0]!, platform.nowMs + 8);
    handle.finish("success");
    platform.setForeground(false);
    await flush(recorder);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      outcome: "success",
      feedback: { elapsedMs: 8 },
      desiredState: { elapsedMs: 8 },
      eventTimingStatus: "cancelled",
    });
  });

  it("preserves observed timing if the telemetry grace timer cannot start", async () => {
    const { platform, recorder, sent } = createHarness({
      withEventTiming: true,
      decoratePlatform: (original) => ({
        ...original,
        schedule: (callback, delayMs) => {
          if (delayMs === 1_000) throw new Error("timer unavailable");
          return original.schedule(callback, delayMs);
        },
      }),
    });
    const handle = recorder.begin(activation(platform));
    platform.recordEventTiming(24);
    handle.committed("feedback");
    platform.returnFrame(platform.frames[0]!, platform.nowMs + 8);
    handle.finish("success");
    await flush(recorder);
    expect(sent[0]).toMatchObject({
      eventTimingMs: 24,
      eventTimingMethod: "browser_event_timing",
      eventTimingStatus: "observed",
    });
  });

  it("keeps an armed observation without an entry distinct from unsupported timing", async () => {
    const { platform, recorder, sent } = createHarness({ withEventTiming: true });
    const handle = recorder.begin(activation(platform));
    handle.committed("feedback");
    platform.returnFrame(platform.frames[0]!, platform.nowMs + 7);
    handle.finish("success");
    platform.advanceBy(1_000);
    await flush(recorder);
    expect(sent[0]).toMatchObject({
      feedback: { elapsedMs: 7 },
      eventTimingMs: null,
      eventTimingMethod: "browser_event_timing",
      eventTimingStatus: "no_entry",
    });
  });

  it("treats a desired-state frame as meaningful feedback", async () => {
    const { platform, recorder, sent } = createHarness();
    const handle = recorder.begin(activation(platform));
    handle.committed("desiredState");
    platform.returnFrame(platform.frames[0]!, platform.nowMs + 11);
    handle.finish("success");
    await flush(recorder);
    expect(sent[0]).toMatchObject({
      feedback: { elapsedMs: 11 },
      desiredState: { elapsedMs: 11 },
      outcome: "success",
    });
  });

  it("contains a throwing consent read at activation and emission", async () => {
    let throws = false;
    const { platform, recorder, sent } = createHarness({
      enabled: () => {
        if (throws) throw new Error("consent unavailable");
        return true;
      },
    });
    const handle = recorder.begin(activation(platform));
    throws = true;
    expect(() => recorder.begin(activation(platform))).not.toThrow();
    expect(() => handle.finish("rejected")).not.toThrow();
    await flush(recorder);
    expect(sent).toHaveLength(0);
  });

  it("does not infer convergence from a rejected action", async () => {
    const { platform, recorder, sent } = createHarness();
    const handle = recorder.begin(activation(platform));
    handle.acknowledged();
    platform.advanceBy(5);
    handle.finish("rejected");

    await flush(recorder);

    expect(sent[0]).toMatchObject({
      feedback: null,
      acknowledgementMs: 0,
      convergenceMs: null,
      completionMs: null,
      outcome: "rejected",
    });
  });

  it("classifies success with a frame that never returns as no_feedback at the deadline", async () => {
    const { platform, recorder, sent } = createHarness();
    const handle = recorder.begin(activation(platform));
    handle.committed("feedback");
    handle.finish("success");

    platform.advanceBy(30_000);
    await flush(recorder);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ feedback: null, outcome: "no_feedback" });
  });

  it("marks an unfinished activation abandoned at the deadline", async () => {
    const { platform, recorder, sent } = createHarness();
    recorder.begin(activation(platform));

    platform.advanceBy(30_000);
    await flush(recorder);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ outcome: "abandoned" });
  });

  it("drops a frame returned after the action moved to background", async () => {
    const { platform, recorder, sent } = createHarness({ withEventTiming: true });
    const handle = recorder.begin(activation(platform));
    handle.committed("both");
    const frame = platform.frames[0]!;

    platform.setForeground(false);
    platform.returnFrame(frame, platform.nowMs + 8, "browser_frame_estimate", true);
    await flush(recorder);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      feedback: null,
      desiredState: null,
      outcome: "background",
      eventTimingStatus: "cancelled",
    });
  });

  it("reuses one activation handle and emits one sample after finish", async () => {
    const { platform, recorder, sent } = createHarness();
    const input = activation(platform);
    const handle = recorder.begin(input);
    handle.committed("feedback");
    platform.returnFrame(platform.frames[0]!, platform.nowMs + 4);
    handle.finish("success");

    const duplicate = recorder.begin(input);
    duplicate.finish("abandoned");
    duplicate.acknowledged();
    await flush(recorder);

    expect(duplicate).toBe(handle);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.outcome).toBe("success");
  });

  it("drops a pending sample when consent is disabled before finish", async () => {
    const harness = createHarness();
    const handle = harness.recorder.begin(activation(harness.platform));
    handle.committed("feedback");
    harness.platform.returnFrame(harness.platform.frames[0]!, harness.platform.nowMs + 4);
    harness.setEnabled(false);
    handle.finish("success");

    await flush(harness.recorder);

    expect(harness.sent).toEqual([]);
    expect(harness.recorder.stats().active).toBe(0);
  });

  it("reset cancels old handles and lets the same activation start fresh", async () => {
    const { platform, recorder, sent } = createHarness();
    const input = activation(platform);
    const oldHandle = recorder.begin(input);
    oldHandle.committed("feedback");
    recorder.reset();

    const newHandle = recorder.begin(input);
    expect(newHandle).not.toBe(oldHandle);
    oldHandle.finish("success");
    oldHandle.committed("feedback");
    newHandle.committed("feedback");
    platform.returnFrame(platform.frames[1]!, platform.nowMs + 3);
    newHandle.finish("success");
    await flush(recorder);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ feedback: { elapsedMs: 3 }, outcome: "success" });
  });

  it("counts future and nonfinite input timestamps as invalid", () => {
    const { platform, recorder } = createHarness();

    recorder.begin(activation(platform, platform.nowMs + 1));
    recorder.begin(activation(platform, Number.NaN));
    recorder.begin(activation(platform, Number.POSITIVE_INFINITY));

    expect(recorder.stats().invalidInputs).toBe(3);
    expect(recorder.stats().active).toBe(0);
  });

  it("does not let failed telemetry throw through the action handler", async () => {
    const { platform, recorder } = createHarness({
      send: async () => {
        throw new Error("telemetry offline");
      },
    });
    const handle = recorder.begin(activation(platform));
    handle.committed("feedback");
    platform.returnFrame(platform.frames[0]!, platform.nowMs + 4);

    expect(() => handle.finish("success")).not.toThrow();
    await expect(flush(recorder)).resolves.toBeUndefined();
  });
});
