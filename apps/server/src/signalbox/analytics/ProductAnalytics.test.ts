import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../../config.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as ProductAnalytics from "./ProductAnalytics.ts";

const T3_HOST = "https://t3.example.test";
const SIGNALBOX_HOST = "https://signalbox.example.test";

const SentBatch = Schema.fromJsonString(
  Schema.Struct({
    api_key: Schema.String,
    batch: Schema.Array(Schema.Struct({ event: Schema.String })),
  }),
);
const decodeSentBatch = Schema.decodeEffect(SentBatch);

interface SentRequest {
  readonly url: string;
  readonly apiKey: string;
  readonly events: ReadonlyArray<string>;
}

/** Records every batch that reaches the network; sends to `failingHost` fail. */
const layerRecordingClient = (sent: Array<SentRequest>, failingHost: string | null) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Uint8Array") {
          const body = yield* decodeSentBatch(new TextDecoder().decode(request.body.body)).pipe(
            Effect.orDie,
          );
          sent.push({
            url: request.url,
            apiKey: body.api_key,
            events: body.batch.map((event) => event.event),
          });
        }
        if (failingHost !== null && request.url.startsWith(failingHost)) {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: "connection refused" }),
          });
        }
        return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }));
      }),
    ),
  );

const layerProductAnalytics = (options: {
  readonly sent: Array<SentRequest>;
  readonly failingHost?: string;
  readonly signalboxKey?: string;
  readonly baseDir: string;
  readonly serverEnabled?: boolean;
}) =>
  ProductAnalytics.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), options.baseDir)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: options.serverEnabled ?? true,
          T3CODE_POSTHOG_KEY: "phc_t3",
          T3CODE_POSTHOG_HOST: T3_HOST,
          ...(options.signalboxKey === undefined
            ? {}
            : { SIGNALBOX_POSTHOG_KEY: options.signalboxKey }),
          SIGNALBOX_POSTHOG_HOST: `${SIGNALBOX_HOST}/`,
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Architecture, "arm64"),
        layerRecordingClient(options.sent, options.failingHost ?? null),
      ),
    ),
  );

const makeBaseDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "signalbox-analytics-" });
});

const advanceSeconds = (seconds: number) =>
  Effect.gen(function* () {
    for (let second = 0; second < seconds; second += 1) {
      yield* TestClock.adjust("1 second");
    }
  });

const eventsSentTo = (sent: ReadonlyArray<SentRequest>, host: string) =>
  sent.filter((request) => request.url.startsWith(host)).flatMap((request) => request.events);

it.layer(NodeServices.layer)("ProductAnalytics", (it) => {
  it.effect("sends every event to both projects, each with its own key", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("client.connected");
        yield* analytics.record("signalbox.feedback.sent", { screenshotAttached: true });
        yield* analytics.flush;
      }).pipe(
        Effect.provide(
          layerProductAnalytics({
            sent,
            signalboxKey: "phc_signalbox",
            baseDir: yield* makeBaseDir,
          }),
        ),
      );

      const expected = ["client.connected", "signalbox.feedback.sent"];
      assert.deepEqual(eventsSentTo(sent, T3_HOST), expected);
      assert.deepEqual(eventsSentTo(sent, SIGNALBOX_HOST), expected);
      assert.isTrue(
        sent.every((request) =>
          request.url.startsWith(T3_HOST)
            ? request.apiKey === "phc_t3"
            : request.apiKey === "phc_signalbox" && request.url === `${SIGNALBOX_HOST}/batch/`,
        ),
      );
    }),
  );

  it.effect("keeps delivering to one project while the other keeps failing", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("first");
        yield* advanceSeconds(3);
        // T3 Code's project is now backing off; ours must not wait for it.
        yield* analytics.record("second");
        yield* advanceSeconds(3);
      }).pipe(
        Effect.provide(
          layerProductAnalytics({
            sent,
            failingHost: T3_HOST,
            signalboxKey: "phc_signalbox",
            baseDir: yield* makeBaseDir,
          }),
        ),
      );

      assert.deepEqual(eventsSentTo(sent, SIGNALBOX_HOST), ["first", "second"]);
      assert.isTrue(eventsSentTo(sent, T3_HOST).includes("first"));
    }),
  );

  it.effect("the opt-out stops both projects, including a batch awaiting retry", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      const layer = layerProductAnalytics({
        sent,
        failingHost: T3_HOST,
        signalboxKey: "phc_signalbox",
        baseDir: yield* makeBaseDir,
      });

      const settings = yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const preference = yield* ProductAnalytics.AnalyticsPreference;
        yield* analytics.record("before");
        yield* advanceSeconds(2);
        const sentBeforeOptOut = sent.length;

        const settings = yield* preference.setEnabled(false);
        yield* analytics.record("after");
        // Long enough for T3 Code's failed batch to come up for retry.
        yield* advanceSeconds(600);
        yield* analytics.flush;
        assert.equal(sent.length, sentBeforeOptOut);
        return settings;
      }).pipe(Effect.provide(layer));
      assert.deepEqual(settings, { enabled: false, disabledByServer: false });

      // The opt-out survives a restart.
      const afterRestart = yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const preference = yield* ProductAnalytics.AnalyticsPreference;
        yield* analytics.record("after.restart");
        yield* analytics.flush;
        return yield* preference.settings;
      }).pipe(Effect.provide(layer));
      assert.isFalse(afterRestart.enabled);
      assert.isFalse(
        sent.some((request) =>
          request.events.some((event) => event === "after" || event === "after.restart"),
        ),
      );
    }),
  );

  it.effect("an unreadable settings file keeps analytics off and is not overwritten", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sent: Array<SentRequest> = [];
      const baseDir = yield* makeBaseDir;
      const layer = layerProductAnalytics({ sent, signalboxKey: "phc_signalbox", baseDir });
      const { stateDir } = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), baseDir),
      );
      const filePath = `${stateDir}/${ProductAnalytics.SIGNALBOX_SETTINGS_FILE}`;
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(filePath, "{ not json");

      const outcome = yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const preference = yield* ProductAnalytics.AnalyticsPreference;
        yield* analytics.record("client.connected");
        yield* analytics.flush;
        const settings = yield* preference.settings;
        const write = yield* Effect.result(preference.setEnabled(true));
        return { settings, write };
      }).pipe(Effect.provide(layer));

      assert.isFalse(outcome.settings.enabled);
      assert.equal(outcome.write._tag, "Failure");
      assert.deepEqual(sent, []);
      assert.equal(yield* fs.readFileString(filePath), "{ not json");
    }),
  );

  it.effect("without a Signalbox key only T3 Code's project receives events", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("client.connected");
        yield* analytics.flush;
      }).pipe(
        Effect.provide(
          layerProductAnalytics({
            sent,
            baseDir: yield* makeBaseDir,
          }),
        ),
      );

      assert.deepEqual(eventsSentTo(sent, T3_HOST), ["client.connected"]);
      assert.deepEqual(eventsSentTo(sent, SIGNALBOX_HOST), []);
    }),
  );

  it.effect("fork-only events go to Signalbox's project alone, and nowhere without a key", () =>
    Effect.gen(function* () {
      const recordWorkload = Effect.gen(function* () {
        const signalbox = yield* ProductAnalytics.SignalboxAnalytics;
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* signalbox.record("workload.turn.completed", { durationSeconds: 1 });
        yield* analytics.flush;
        return yield* signalbox.active;
      });

      const sent: Array<SentRequest> = [];
      const active = yield* recordWorkload.pipe(
        Effect.provide(
          layerProductAnalytics({
            sent,
            signalboxKey: "phc_signalbox",
            baseDir: yield* makeBaseDir,
          }),
        ),
      );
      assert.isTrue(active);
      assert.deepEqual(eventsSentTo(sent, SIGNALBOX_HOST), ["workload.turn.completed"]);
      assert.deepEqual(eventsSentTo(sent, T3_HOST), []);

      const sentWithoutKey: Array<SentRequest> = [];
      const activeWithoutKey = yield* recordWorkload.pipe(
        Effect.provide(
          layerProductAnalytics({ sent: sentWithoutKey, baseDir: yield* makeBaseDir }),
        ),
      );
      assert.isFalse(activeWithoutKey);
      assert.deepEqual(sentWithoutKey, []);

      // The server-wide switch turns workload collection off too.
      const activeWhenDisabled = yield* recordWorkload.pipe(
        Effect.provide(
          layerProductAnalytics({
            sent: [],
            signalboxKey: "phc_signalbox",
            serverEnabled: false,
            baseDir: yield* makeBaseDir,
          }),
        ),
      );
      assert.isFalse(activeWhenDisabled);
    }),
  );
});
