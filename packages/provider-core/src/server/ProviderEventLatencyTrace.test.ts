import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

it.effect("creates its clock realm only on the first debug trace in an active request", () =>
  Effect.gen(function* () {
    const originalCrypto = globalThis.crypto;
    let requestActive = false;
    let uuidCalls = 0;
    vi.resetModules();
    vi.stubGlobal(
      "crypto",
      Object.assign(Object.create(originalCrypto), {
        randomUUID: () => {
          if (!requestActive) throw new Error("crypto.randomUUID requires an active request");
          uuidCalls += 1;
          return `test-realm-${uuidCalls}`;
        },
      }),
    );

    try {
      const traceModule = yield* Effect.promise(
        () => import("@t3tools/provider-core/server/ProviderEventLatencyTrace"),
      );
      assert.equal(uuidCalls, 0);

      const trace = {
        traceId: "test-trace",
        streamId: "test-stream",
        streamOrdinal: 1,
        eventType: "message.updated",
        createdAtMs: 1,
      };
      const infoLogs: Array<string> = [];
      const infoCapture = Logger.map(Logger.formatJson, (line) => void infoLogs.push(line));
      yield* traceModule
        .logProviderEventLatency("info-only", trace)
        .pipe(
          Effect.provideService(References.MinimumLogLevel, "Info"),
          Effect.provide(Logger.layer([infoCapture], { mergeWithExisting: false })),
        );
      assert.equal(uuidCalls, 0);
      assert.deepEqual(infoLogs, []);

      requestActive = true;
      const debugLogs: Array<string> = [];
      const debugCapture = Logger.map(Logger.formatJson, (line) => void debugLogs.push(line));
      yield* traceModule
        .logProviderEventLatency("first-debug", trace)
        .pipe(
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.provide(Logger.layer([debugCapture], { mergeWithExisting: false })),
        );
      const firstRealmId = traceModule.providerEventLatencyClock.realmId;

      yield* traceModule
        .logProviderEventLatency("second-debug", trace)
        .pipe(
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.provide(Logger.layer([debugCapture], { mergeWithExisting: false })),
        );
      const secondRealmId = traceModule.providerEventLatencyClock.realmId;

      assert.equal(uuidCalls, 1);
      assert.equal(firstRealmId, secondRealmId);
      assert.include(firstRealmId, "test-realm-1");
      assert.equal(debugLogs.length, 2);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  }),
);
