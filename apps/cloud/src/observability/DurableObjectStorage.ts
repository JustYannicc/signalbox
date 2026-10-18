import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Evlog from "./Evlog.ts";

/** Cloudflare's Durable Object SQLite limit is ten decimal gigabytes. */
export const DURABLE_OBJECT_STORAGE_CAP_BYTES = 10_000_000_000;
export const DURABLE_OBJECT_STORAGE_SAMPLE_INTERVAL_MS = 60 * 60 * 1_000;
const STORAGE_SAMPLE_KEY = "signalbox:telemetry:durable-object-storage:v1";
const STORAGE_FAILURE_RETRY_MS = 60_000;

export type DurableObjectStorageKind = "user" | "home";
export type DurableObjectStorageLevel = "person" | "organization" | "folder";

export interface DurableObjectStorageIdentity {
  readonly kind: DurableObjectStorageKind;
  readonly level: DurableObjectStorageLevel;
}

export interface DurableObjectStorageObserverEnv {
  readonly SIGNALBOX_DO_STORAGE_ALERT_PERCENT?: string;
  readonly T3CODE_TELEMETRY_ENABLED?: string;
}

/** The observer deliberately depends on only the storage surface it uses. */
export interface DurableObjectStorageObserverContext {
  readonly id: { readonly toString: () => string };
  readonly storage: {
    readonly sql: { readonly databaseSize: number };
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

interface SampleMarker {
  readonly sampledAtMs: number;
  readonly thresholdPercent: number;
}

const DEFAULT_THRESHOLD_PERCENT = 70;
const now = () => Effect.runSync(Clock.currentTimeMillis);
const isDisabled = (value: string | undefined) =>
  ["false", "no", "off", "0", "n"].includes(value?.trim().toLowerCase() ?? "");

const thresholdFromEnv = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") return DEFAULT_THRESHOLD_PERCENT;
  const threshold = Number(value.trim());
  return Number.isFinite(threshold) && threshold >= 0 && threshold <= 100
    ? threshold
    : DEFAULT_THRESHOLD_PERCENT;
};

const readMarker = (value: unknown): SampleMarker | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const marker = value as Record<string, unknown>;
  if (
    typeof marker.sampledAtMs !== "number" ||
    !Number.isFinite(marker.sampledAtMs) ||
    marker.sampledAtMs < 0 ||
    typeof marker.thresholdPercent !== "number" ||
    !Number.isFinite(marker.thresholdPercent) ||
    marker.thresholdPercent < 0 ||
    marker.thresholdPercent > 100
  ) {
    return undefined;
  }
  return {
    sampledAtMs: marker.sampledAtMs,
    thresholdPercent: marker.thresholdPercent,
  };
};

const shouldSample = (marker: SampleMarker | undefined, nowMs: number, threshold: number) => {
  if (marker === undefined) return true;
  // A lower threshold needs a fresh reading right away. A clock correction
  // backwards also gets one sample, then the marker follows the new clock.
  if (threshold < marker.thresholdPercent || nowMs < marker.sampledAtMs) return true;
  return nowMs - marker.sampledAtMs >= DURABLE_OBJECT_STORAGE_SAMPLE_INTERVAL_MS;
};

const safeObjectId = (id: DurableObjectStorageObserverContext["id"]) => {
  try {
    const value = id.toString();
    return /^[0-9a-f]{64}$/i.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Start a content-free, hourly storage sample without putting telemetry on a
 * Durable Object's request path. The one reserved key is only a cadence marker.
 */
export const makeStorageObserver = (
  ctx: DurableObjectStorageObserverContext,
  identity: DurableObjectStorageIdentity,
  env: DurableObjectStorageObserverEnv,
): (() => void) => {
  if (isDisabled(env.T3CODE_TELEMETRY_ENABLED)) return () => {};

  const thresholdPercent = thresholdFromEnv(env.SIGNALBOX_DO_STORAGE_ALERT_PERCENT);
  let inFlight: Promise<void> | undefined;
  let localReady = false;
  let localMarker: SampleMarker | undefined;
  let localRetryAtMs = 0;

  const observe = async () => {
    const nowMs = now();
    if (nowMs < localRetryAtMs) return;

    const id = safeObjectId(ctx.id);
    if (id === undefined) return;

    let marker = localMarker;
    if (!localReady) {
      try {
        marker = readMarker(await ctx.storage.get(STORAGE_SAMPLE_KEY));
        localMarker = marker;
        localReady = true;
        localRetryAtMs = 0;
      } catch {
        localRetryAtMs = nowMs + STORAGE_FAILURE_RETRY_MS;
        return;
      }
    }
    if (!shouldSample(marker, nowMs, thresholdPercent)) return;

    let bytes: number;
    try {
      // Read Cloudflare's native getter only after the durable cadence check.
      bytes = ctx.storage.sql.databaseSize;
    } catch {
      localRetryAtMs = nowMs + STORAGE_FAILURE_RETRY_MS;
      return;
    }

    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      localRetryAtMs = nowMs + STORAGE_FAILURE_RETRY_MS;
      return;
    }

    const utilizationPercent = (bytes / DURABLE_OBJECT_STORAGE_CAP_BYTES) * 100;
    const status = utilizationPercent >= thresholdPercent ? "high" : "ok";
    const sampledAtMs = now();
    const nextMarker = { sampledAtMs, thresholdPercent } satisfies SampleMarker;
    try {
      // Persist before emitting so hibernation cannot turn each request into a
      // new sample. A full database can reject this marker, but the reading is
      // still useful and the in-memory marker prevents request-path retries.
      await ctx.storage.put(STORAGE_SAMPLE_KEY, nextMarker);
    } catch {
      // Hibernation cannot preserve a marker if storage is unwritable.
    }
    localMarker = nextMarker;
    localReady = true;
    localRetryAtMs = 0;

    const fields = {
      "durableObject.id": id,
      "durableObject.kind": identity.kind,
      "durableObject.level": identity.level,
      "storage.bytes": bytes,
      "storage.capBytes": DURABLE_OBJECT_STORAGE_CAP_BYTES,
      "storage.utilizationPercent": utilizationPercent,
      "storage.thresholdPercent": thresholdPercent,
      "storage.status": status,
    } satisfies Evlog.CloudFields;
    const report = Effect.gen(function* () {
      const log = yield* Evlog.logger;
      log.set(fields);
      if (status === "high") log.setLevel("error");
      yield* Effect.logInfo(
        status === "high"
          ? "Durable Object storage capacity threshold exceeded"
          : "Durable Object storage capacity sampled",
      );
    }).pipe(
      Evlog.withUnit("durableObject.storage"),
      Effect.provide(Layer.mergeAll(Evlog.layer, Evlog.layerWaitUntil(ctx))),
    );
    await Effect.runPromise(report).catch(() => undefined);
  };

  return () => {
    if (inFlight !== undefined) return;
    const nowMs = now();
    if (nowMs < localRetryAtMs) return;
    if (localReady && !shouldSample(localMarker, nowMs, thresholdPercent)) return;
    const pending = observe()
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        if (inFlight === pending) inFlight = undefined;
      });
    inFlight = pending;
    try {
      ctx.waitUntil(pending);
    } catch {
      // The task has already started; the caller's operation stays isolated.
    }
  };
};
