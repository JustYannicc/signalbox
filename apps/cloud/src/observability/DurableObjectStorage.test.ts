import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { initLogger, type WideEvent } from "evlog";
import { toSentryErrorEvent, toSentryLog } from "evlog/sentry";

import { redactContent } from "./content.ts";
import {
  DURABLE_OBJECT_STORAGE_CAP_BYTES,
  DURABLE_OBJECT_STORAGE_SAMPLE_INTERVAL_MS,
  makeStorageObserver,
  type DurableObjectStorageObserverContext,
} from "./DurableObjectStorage.ts";

const T0 = 1_800_000_000_000;
const OBJECT_ID = "0123456789abcdef".repeat(4);

interface FakeStorage {
  readonly storage: DurableObjectStorageObserverContext["storage"];
  readonly reads: { gets: number; databaseSizes: number; puts: number };
  readonly values: Map<string, unknown>;
  databaseSize: number;
  failGet: boolean;
  failPut: boolean;
}

const fakeStorage = (databaseSize: number): FakeStorage => {
  const values = new Map<string, unknown>();
  const reads = { gets: 0, databaseSizes: 0, puts: 0 };
  const fake: FakeStorage = {
    reads,
    values,
    databaseSize,
    failGet: false,
    failPut: false,
    storage: {
      sql: {
        get databaseSize() {
          reads.databaseSizes += 1;
          return fake.databaseSize;
        },
      },
      async get<T>(key: string) {
        reads.gets += 1;
        if (fake.failGet) throw new Error("storage read failed");
        return values.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T) {
        reads.puts += 1;
        if (fake.failPut) throw new Error("storage write failed");
        values.set(key, value);
      },
    },
  };
  return fake;
};

const fakeContext = (
  storage: FakeStorage,
  objectId = OBJECT_ID,
  pending: Array<Promise<unknown>> = [],
) => ({
  id: { toString: () => objectId },
  storage: storage.storage,
  waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  pending,
});

const captureEvents = () => {
  const events: Array<WideEvent> = [];
  initLogger({
    silent: true,
    redact: { transform: redactContent },
    drain: ({ event }) => {
      events.push(event);
    },
  });
  return events;
};

const flush = async (pending: Array<Promise<unknown>>) => {
  while (pending.length > 0) await Promise.allSettled(pending.splice(0));
};

afterEach(() => vi.useRealTimers());

describe("Durable Object storage observer", () => {
  it("reports searchable byte counts and a fixed high-capacity issue", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const events = captureEvents();
    const storage = fakeStorage(8_000_000_000);
    const ctx = fakeContext(storage);
    const observe = makeStorageObserver(
      ctx,
      { kind: "user", level: "person" },
      {
        SIGNALBOX_DO_STORAGE_ALERT_PERCENT: "not-a-number",
      },
    );

    observe();
    observe();
    await flush(ctx.pending);

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      action: "durableObject.storage",
      level: "error",
      "durableObject.id": OBJECT_ID,
      "durableObject.kind": "user",
      "durableObject.level": "person",
      "storage.bytes": 8_000_000_000,
      "storage.capBytes": DURABLE_OBJECT_STORAGE_CAP_BYTES,
      "storage.utilizationPercent": 80,
      "storage.thresholdPercent": 70,
      "storage.status": "high",
      error: { name: "DurableObjectStorageCapacity" },
    });
    const config = { dsn: "https://public@example.com/1" };
    const outgoing = JSON.stringify({
      event,
      log: toSentryLog(event, config),
      issue: toSentryErrorEvent(event, config),
    });
    expect(toSentryLog(event, config).attributes?.["storage.bytes"]).toEqual({
      value: 8_000_000_000,
      type: "integer",
    });
    expect(toSentryErrorEvent(event, config).exception.values[0]?.type).toBe(
      "DurableObjectStorageCapacity",
    );
    expect(outgoing).not.toContain("signalbox:telemetry");
    expect(storage.reads.databaseSizes).toBe(1);
    expect(storage.reads.gets).toBe(1);
  });

  it("treats exactly seventy percent as high and rejects out-of-range thresholds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const events = captureEvents();
    const storage = fakeStorage(7_000_000_000);
    const ctx = fakeContext(storage);

    makeStorageObserver(
      ctx,
      { kind: "user", level: "person" },
      {
        SIGNALBOX_DO_STORAGE_ALERT_PERCENT: "101",
      },
    )();
    await flush(ctx.pending);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error",
      "storage.bytes": 7_000_000_000,
      "storage.utilizationPercent": 70,
      "storage.thresholdPercent": 70,
      "storage.status": "high",
    });
  });

  it("persists the hourly cadence and samples immediately when the threshold drops", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const events = captureEvents();
    const storage = fakeStorage(6_500_000_000);
    const first = fakeContext(storage);
    const observeFirst = makeStorageObserver(
      first,
      { kind: "home", level: "folder" },
      {
        SIGNALBOX_DO_STORAGE_ALERT_PERCENT: "80",
      },
    );

    observeFirst();
    await flush(first.pending);
    observeFirst();
    await flush(first.pending);
    expect(storage.reads.gets).toBe(1);

    const recreated = fakeContext(storage);
    makeStorageObserver(
      recreated,
      { kind: "home", level: "folder" },
      {
        SIGNALBOX_DO_STORAGE_ALERT_PERCENT: "80",
      },
    )();
    await flush(recreated.pending);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "info",
      "durableObject.kind": "home",
      "durableObject.level": "folder",
      "storage.status": "ok",
    });
    expect(storage.reads.databaseSizes).toBe(1);

    const lowered = fakeContext(storage);
    makeStorageObserver(
      lowered,
      { kind: "home", level: "folder" },
      {
        SIGNALBOX_DO_STORAGE_ALERT_PERCENT: "60",
      },
    )();
    await flush(lowered.pending);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      level: "error",
      "storage.thresholdPercent": 60,
      "storage.status": "high",
    });
    expect(storage.reads.databaseSizes).toBe(2);

    const sameThreshold = fakeContext(storage);
    makeStorageObserver(
      sameThreshold,
      { kind: "home", level: "folder" },
      {
        SIGNALBOX_DO_STORAGE_ALERT_PERCENT: "60",
      },
    )();
    await flush(sameThreshold.pending);
    expect(events).toHaveLength(2);

    vi.setSystemTime(T0 + DURABLE_OBJECT_STORAGE_SAMPLE_INTERVAL_MS);
    const hourly = fakeContext(storage);
    makeStorageObserver(
      hourly,
      { kind: "home", level: "folder" },
      {
        SIGNALBOX_DO_STORAGE_ALERT_PERCENT: "60",
      },
    )();
    await flush(hourly.pending);
    expect(events).toHaveLength(3);
    expect(storage.reads.databaseSizes).toBe(3);
  });

  it("repairs a corrupt marker and follows a backwards clock once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const events = captureEvents();
    const storage = fakeStorage(1_000_000_000);
    storage.values.set("signalbox:telemetry:durable-object-storage:v1", {
      sampledAtMs: "bad",
    });
    const initial = fakeContext(storage);

    makeStorageObserver(initial, { kind: "user", level: "person" }, {})();
    await flush(initial.pending);
    expect(events).toHaveLength(1);
    expect(storage.reads.databaseSizes).toBe(1);
    expect(storage.values.get("signalbox:telemetry:durable-object-storage:v1")).toEqual({
      sampledAtMs: T0,
      thresholdPercent: 70,
    });

    vi.setSystemTime(T0 - 1_000);
    const corrected = fakeContext(storage);
    makeStorageObserver(corrected, { kind: "user", level: "person" }, {})();
    await flush(corrected.pending);
    expect(events).toHaveLength(2);

    const repeated = fakeContext(storage);
    makeStorageObserver(repeated, { kind: "user", level: "person" }, {})();
    await flush(repeated.pending);
    expect(events).toHaveLength(2);
    expect(storage.reads.databaseSizes).toBe(2);
  });

  it("fails closed for unsafe IDs, invalid sizes, read failures and disabled telemetry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const events = captureEvents();

    const unsafeStorage = fakeStorage(1_000_000_000);
    const unsafe = fakeContext(unsafeStorage, "user-private-name");
    makeStorageObserver(unsafe, { kind: "user", level: "person" }, {})();
    await flush(unsafe.pending);
    expect(unsafeStorage.reads.gets).toBe(0);

    const invalidStorage = fakeStorage(Number.NaN);
    const invalid = fakeContext(invalidStorage);
    const invalidObserver = makeStorageObserver(invalid, { kind: "user", level: "person" }, {});
    invalidObserver();
    invalidObserver();
    await flush(invalid.pending);
    expect(invalidStorage.reads.databaseSizes).toBe(1);
    expect(invalidStorage.reads.puts).toBe(0);

    const failedStorage = fakeStorage(1_000_000_000);
    failedStorage.failGet = true;
    const failed = fakeContext(failedStorage);
    const failedObserver = makeStorageObserver(failed, { kind: "user", level: "person" }, {});
    failedObserver();
    failedObserver();
    await flush(failed.pending);
    failedObserver();
    await flush(failed.pending);
    expect(failedStorage.reads.gets).toBe(1);

    const failedWriteStorage = fakeStorage(DURABLE_OBJECT_STORAGE_CAP_BYTES);
    failedWriteStorage.failPut = true;
    const failedWrite = fakeContext(failedWriteStorage);
    const failedWriteObserver = makeStorageObserver(
      failedWrite,
      { kind: "user", level: "person" },
      {},
    );
    expect(() => failedWriteObserver()).not.toThrow();
    await flush(failedWrite.pending);
    failedWriteObserver();
    await flush(failedWrite.pending);
    expect(failedWriteStorage.reads.databaseSizes).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "durableObject.storage",
      level: "error",
      "storage.bytes": DURABLE_OBJECT_STORAGE_CAP_BYTES,
      "storage.status": "high",
    });

    for (const disabled of ["false", "NO", " Off ", "0", "n"]) {
      const disabledStorage = fakeStorage(1_000_000_000);
      const disabledCtx = fakeContext(disabledStorage);
      makeStorageObserver(
        disabledCtx,
        { kind: "user", level: "person" },
        {
          T3CODE_TELEMETRY_ENABLED: disabled,
        },
      )();
      expect(disabledCtx.pending).toHaveLength(0);
      expect(disabledStorage.reads.gets).toBe(0);
    }

    expect(events).toHaveLength(1);
  });
});
