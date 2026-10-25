import { SIGNALBOX_ANALYTICS_WS_METHODS } from "@t3tools/contracts/signalboxAnalytics";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import { AnalyticsPreference } from "./ProductAnalytics.ts";
import { makeSignalboxAnalyticsWsHandlers } from "./rpc.ts";

it.effect("keeps operational timing out of self-hosted product analytics", () => {
  const events: string[] = [];
  return Effect.gen(function* () {
    const handlers = yield* makeSignalboxAnalyticsWsHandlers({ clientType: "web" });
    const record = handlers[SIGNALBOX_ANALYTICS_WS_METHODS.recordClientEvent];
    yield* record({
      event: "interaction.timings",
      samples: [
        {
          action: "thread.send",
          entryPoint: "key",
          client: "web",
          os: "linux",
          device: "computer",
          release: "development",
          connection: "online",
          mode: "local",
          path: "optimistic",
          inputTimeMs: 100,
          handlerDelayMs: 2,
          feedback: { elapsedMs: 12, method: "browser_frame_estimate" },
          desiredState: null,
          eventTimingMs: null,
          eventTimingMethod: null,
          eventTimingStatus: "unavailable",
          acknowledgementMs: null,
          convergenceMs: null,
          completionMs: null,
          outcome: "success",
          correlationId: "123456789abcdef0123456789abcdef0",
        },
      ],
    });
    yield* record({ event: "capture.used" });
    expect(events).toEqual(["signalbox.capture.used"]);
  }).pipe(
    Effect.provideService(AnalyticsService, {
      record: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      flush: Effect.void,
    }),
    Effect.provideService(AnalyticsPreference, {
      settings: Effect.succeed({ enabled: true, disabledByServer: false }),
      setEnabled: (enabled) => Effect.succeed({ enabled, disabledByServer: false }),
    }),
  );
});
