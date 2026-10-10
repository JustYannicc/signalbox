/**
 * Sends every product analytics event to two PostHog projects: T3 Code's
 * (upstream's default) and Signalbox's. Each destination is its own instance
 * of upstream's `AnalyticsService.make`, so each keeps its own buffer, retry
 * backoff, and drop limit, and one failing never delays or drops the other.
 *
 * The Settings opt-out (`AnalyticsPreference`) stops both. It is checked when
 * an event is recorded and again at send time, so a batch queued or awaiting
 * retry when the user opts out is discarded instead of sent.
 *
 * Signalbox's key and host come from `SIGNALBOX_POSTHOG_KEY` / `_HOST` at
 * runtime, else from the build (`__SIGNALBOX_BUILD_POSTHOG_*__`, read from the
 * repo `.env` by the server bundle). Without a key only T3 Code's project
 * receives events.
 *
 * @module ProductAnalytics
 */
import type { ScheduledTask } from "@t3tools/contracts";
import {
  ProductAnalyticsSettingsError,
  type ProductAnalyticsSettings,
} from "@t3tools/contracts/signalboxAnalytics";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../../config.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";

declare const __SIGNALBOX_BUILD_POSTHOG_KEY__: string | undefined;
declare const __SIGNALBOX_BUILD_POSTHOG_HOST__: string | undefined;

const buildTimeKey =
  typeof __SIGNALBOX_BUILD_POSTHOG_KEY__ === "undefined" ? "" : __SIGNALBOX_BUILD_POSTHOG_KEY__;
const buildTimeHost =
  typeof __SIGNALBOX_BUILD_POSTHOG_HOST__ === "undefined" ? "" : __SIGNALBOX_BUILD_POSTHOG_HOST__;

const SignalboxDestinationConfig = Config.all({
  key: Config.String("SIGNALBOX_POSTHOG_KEY").pipe(Config.withDefault(buildTimeKey)),
  host: Config.String("SIGNALBOX_POSTHOG_HOST").pipe(
    Config.withDefault(buildTimeHost.trim() || "https://us.i.posthog.com"),
  ),
  // Upstream's environment opt-out. It already stops both destinations; read
  // here so Settings can show the switch as off instead of lying.
  serverEnabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
});

/** Fork-owned settings file; upstream's settings.json drops unknown keys. */
export const SIGNALBOX_SETTINGS_FILE = "signalbox-settings.json";

const SettingsFile = Schema.Record(Schema.String, Schema.Unknown);
type SettingsFile = typeof SettingsFile.Type;
const decodeSettingsFile = Schema.decodeEffect(fromLenientJson(SettingsFile));
const encodeSettingsFile = Schema.encodeEffect(fromJsonStringPretty(SettingsFile));

export class AnalyticsPreference extends Context.Service<
  AnalyticsPreference,
  {
    readonly settings: Effect.Effect<ProductAnalyticsSettings>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<ProductAnalyticsSettings, ProductAnalyticsSettingsError>;
  }
>()("t3/signalbox/analytics/ProductAnalytics/AnalyticsPreference") {}

const makePreference = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const { serverEnabled } = yield* SignalboxDestinationConfig;
  const filePath = path.join(stateDir, SIGNALBOX_SETTINGS_FILE);

  // Only a missing file is empty. An unreadable one is never overwritten,
  // because unknown keys (later fork settings) must survive a write.
  const readFile = fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeSettingsFile),
    Effect.catchIf(
      (cause) => cause._tag === "PlatformError" && cause.reason._tag === "NotFound",
      () => Effect.succeed<SettingsFile>({}),
    ),
    Effect.mapError((cause) => new ProductAnalyticsSettingsError({ detail: cause.message })),
  );
  // Fails closed: a file we can't read may hold an opt-out.
  const initiallyEnabled = yield* readFile.pipe(
    Effect.map((file) => file.productAnalytics !== false),
    Effect.catch((cause) =>
      Effect.logWarning(`${SIGNALBOX_SETTINGS_FILE} is unreadable; analytics stay off`, {
        cause,
      }).pipe(Effect.as(false)),
    ),
  );
  const enabledRef = yield* Ref.make(initiallyEnabled);
  const writeLock = yield* Semaphore.make(1);

  const settings = Effect.map(Ref.get(enabledRef), (enabled): ProductAnalyticsSettings => ({
    enabled: enabled && serverEnabled,
    disabledByServer: !serverEnabled,
  }));

  const persist = (enabled: boolean) =>
    readFile.pipe(
      Effect.flatMap((current) => encodeSettingsFile({ ...current, productAnalytics: enabled })),
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath, contents: `${contents}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new ProductAnalyticsSettingsError({ detail: cause.message })),
    );

  // Opting out applies before the write, so a failed save still stops
  // sending; opting in waits for the save.
  const setEnabled = (enabled: boolean) =>
    Effect.gen(function* () {
      if (!enabled) yield* Ref.set(enabledRef, false);
      yield* persist(enabled);
      yield* Ref.set(enabledRef, enabled);
      return yield* settings;
    }).pipe(writeLock.withPermit);

  return {
    service: AnalyticsPreference.of({ settings, setEnabled }),
    // The server-wide switch stops everything the opt-out does.
    isEnabled: Effect.map(Ref.get(enabledRef), (enabled) => enabled && serverEnabled),
  };
});

/**
 * Fork-only events, such as workload usage, that go to Signalbox's project
 * alone. Same identity and opt-out as every other event; without a Signalbox
 * key they are dropped.
 */
export class SignalboxAnalytics extends Context.Service<
  SignalboxAnalytics,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;
    /** Whether a recorded event would be sent: a key is set and the user hasn't opted out. */
    readonly active: Effect.Effect<boolean>;
  }
>()("t3/signalbox/analytics/ProductAnalytics/SignalboxAnalytics") {}

/**
 * Replaces upstream's `AnalyticsService.layer`; also provides
 * `AnalyticsPreference` and `SignalboxAnalytics`.
 */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const preference = yield* makePreference;
    const destination = yield* SignalboxDestinationConfig;
    const ambientConfig = yield* ConfigProvider.ConfigProvider;
    const httpClient = yield* HttpClient.HttpClient;

    // An opted-out send answers itself, so the instance discards the batch
    // as delivered and nothing leaves the machine.
    const consentedHttpClient = HttpClient.transform(httpClient, (send, request) =>
      Effect.flatMap(preference.isEnabled, (enabled) =>
        enabled
          ? send
          : Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
            ),
      ),
    );
    const makeDestination = AnalyticsService.make.pipe(
      Effect.provideService(HttpClient.HttpClient, consentedHttpClient),
    );

    // Sequential: both instances resolve the identity, and the first may
    // create the anonymous id the second must reuse.
    const t3Destination = yield* makeDestination;
    const signalboxKey = destination.key.trim();
    const signalboxDestination = signalboxKey
      ? yield* makeDestination.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({
                T3CODE_POSTHOG_KEY: signalboxKey,
                T3CODE_POSTHOG_HOST: destination.host.trim().replace(/\/+$/, ""),
              }),
              ambientConfig,
            ),
          ),
        )
      : undefined;
    const destinations =
      signalboxDestination === undefined ? [t3Destination] : [t3Destination, signalboxDestination];
    const recordTo =
      (targets: ReadonlyArray<AnalyticsService.AnalyticsService["Service"]>) =>
      (event: string, properties?: Readonly<Record<string, unknown>>) =>
        Effect.flatMap(preference.isEnabled, (enabled) =>
          enabled
            ? Effect.forEach(targets, (target) => target.record(event, properties), {
                discard: true,
              })
            : Effect.void,
        );

    const analytics = AnalyticsService.AnalyticsService.of({
      record: recordTo(destinations),
      // Concurrent, so one destination's hung send doesn't hold up the other.
      flush: Effect.forEach(destinations, (target) => target.flush, {
        concurrency: "unbounded",
        discard: true,
      }),
    });

    return Context.make(AnalyticsService.AnalyticsService, analytics).pipe(
      Context.add(AnalyticsPreference, preference.service),
      Context.add(
        SignalboxAnalytics,
        SignalboxAnalytics.of({
          record: recordTo(signalboxDestination === undefined ? [] : [signalboxDestination]),
          active: signalboxDestination === undefined ? Effect.succeed(false) : preference.isEnabled,
        }),
      ),
    );
  }),
);

/** The scheduler's handle; it keeps working without analytics (tests). */
export const automationAnalytics = Effect.serviceOption(AnalyticsService.AnalyticsService);

/** `signalbox.automation.run`: one scheduled task run finished dispatching. */
export const recordAutomationRun = (
  analytics: Option.Option<AnalyticsService.AnalyticsService["Service"]>,
  task: Pick<ScheduledTask, "schedule" | "threadId">,
  trigger: "scheduled" | "manual" | "webhook",
  outcome: "succeeded" | "failed",
) =>
  Option.match(analytics, {
    onNone: () => Effect.void,
    onSome: (service) =>
      service.record("signalbox.automation.run", {
        trigger,
        schedule: task.schedule.type,
        target: task.threadId === null ? "new-thread" : "bound-thread",
        outcome,
      }),
  });
