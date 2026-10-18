import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopCaptureShutdown from "../capture/DesktopCaptureShutdown.ts";

function layerElectronApp(
  appListeners: Map<string, (...args: readonly unknown[]) => void>,
  quit: Effect.Effect<void> = Effect.void,
  overrides: Partial<Pick<ElectronApp.ElectronApp["Service"], "exit" | "relaunch">> = {},
) {
  const registerListener = (eventName: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appListeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appListeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("Signalbox"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    quit,
    exit: overrides.exit ?? (() => Effect.void),
    relaunch: overrides.relaunch ?? (() => Effect.void),
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: (listener) => registerListener("before-quit-for-update", listener),
    on: (eventName, listener) =>
      registerListener(eventName, listener as unknown as (...args: readonly unknown[]) => void),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

function layerElectronWindow(destroyAll: Effect.Effect<void> = Effect.void) {
  return Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.die("unexpected main window read"),
    currentMainOrFirst: Effect.die("unexpected current window read"),
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });
}

function layerDesktopWindow(
  input: {
    readonly activate?: Effect.Effect<void>;
    readonly flushMainWindowBounds?: Effect.Effect<void>;
  } = {},
) {
  return Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: input.activate ?? Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: input.flushMainWindowBounds ?? Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: () => Effect.void,
    dispatchSnapShotEvent: () => Effect.void,
    dispatchCaptureEvent: () => Effect.void,
    zoomMain: () => Effect.void,
    runMainContentsCommand: () => Effect.void,
    syncAppearance: Effect.void,
  });
}

describe("DesktopLifecycle", () => {
  it.effect.each(["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "lets the updater's quit event proceed on %s",
    (platform) => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let windowsDestroyed = false;
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(
          layerElectronWindow(
            Effect.sync(() => {
              windowsDestroyed = true;
            }),
          ),
        ),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        Layer.provideMerge(DesktopCaptureShutdown.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();
          yield* Effect.yieldNow;

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );
          assert.isTrue(windowsDestroyed);

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "waits for the capture commit before destroying windows and requesting backend shutdown",
    () =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const shutdownRequested = yield* Deferred.make<void>();
        const allowShutdown = yield* Deferred.make<void>();
        const quitRequested = yield* Deferred.make<void>();
        const captureRequested = yield* Deferred.make<string>();
        const events: string[] = [];

        const quit = Effect.sync(() => {
          events.push("quit");
        }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined)), Effect.asVoid);
        const destroyAll = Effect.sync(() => {
          events.push("destroy");
        });
        const flushMainWindowBounds = Effect.sync(() => {
          events.push("flush");
        });

        const layerDesktopShutdown = Layer.succeed(DesktopShutdown.DesktopShutdown, {
          request: Effect.sync(() => {
            events.push("request");
          }).pipe(Effect.andThen(Deferred.succeed(shutdownRequested, undefined)), Effect.asVoid),
          awaitRequest: Deferred.await(shutdownRequested),
          markComplete: Deferred.succeed(allowShutdown, undefined).pipe(Effect.asVoid),
          awaitComplete: Deferred.await(allowShutdown),
          isComplete: Deferred.isDone(allowShutdown),
        });

        const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]);

        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(layerElectronApp(appListeners, quit)),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(layerElectronWindow(destroyAll)),
          Layer.provideMerge(layerDesktopWindow({ flushMainWindowBounds })),
          Layer.provideMerge(layerEnvironment),
          Layer.provideMerge(layerDesktopShutdown),
          Layer.provideMerge(DesktopState.layer),
          Layer.provideMerge(DesktopCaptureShutdown.layer),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
            const capture = yield* DesktopCaptureShutdown.DesktopCaptureShutdown;
            yield* capture.register({
              request: (requestId) =>
                Effect.sync(() => {
                  events.push("capture-flush");
                }).pipe(
                  Effect.andThen(Deferred.succeed(captureRequested, requestId)),
                  Effect.as(true),
                ),
              release: () => Effect.void,
            });
            yield* lifecycle.register;

            const event = { preventDefault: () => undefined } as Electron.Event;
            appListeners.get("before-quit")?.(event);

            const requestId = yield* Deferred.await(captureRequested);
            assert.deepEqual(events, ["capture-flush"]);
            assert.isFalse(yield* Deferred.isDone(shutdownRequested));
            yield* capture.complete({ requestId, error: null });

            yield* Deferred.await(shutdownRequested);
            const eventsBeforeCleanup = [...events];
            yield* Deferred.succeed(allowShutdown, undefined);
            yield* Deferred.await(quitRequested);

            assert.deepEqual(eventsBeforeCleanup, ["capture-flush", "flush", "destroy", "request"]);
            assert.deepEqual(events, ["capture-flush", "flush", "destroy", "request", "quit"]);
          }),
        ).pipe(Effect.provide(layer));
      }),
  );

  it.effect("keeps windows and the app available when capture persistence rejects quit", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const requested = yield* Deferred.make<string>();
      const recovered = yield* Deferred.make<void>();
      const events: string[] = [];
      const errors: string[] = [];
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(
          layerElectronApp(
            appListeners,
            Effect.sync(() => {
              events.push("quit");
            }),
          ),
        ),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(
          layerElectronWindow(
            Effect.sync(() => {
              events.push("destroy");
            }),
          ),
        ),
        Layer.provideMerge(
          layerDesktopWindow({
            activate: Effect.sync(() => {
              events.push("activate");
            }),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            platform: "darwin",
            isDevelopment: false,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        Layer.provideMerge(DesktopCaptureShutdown.layer),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const capture = yield* DesktopCaptureShutdown.DesktopCaptureShutdown;
          yield* capture.register({
            request: (requestId) => Deferred.succeed(requested, requestId).pipe(Effect.as(true)),
            release: (error) =>
              error === null
                ? Deferred.succeed(recovered, undefined).pipe(Effect.asVoid)
                : Effect.sync(() => {
                    errors.push(error);
                  }),
          });
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;
          appListeners.get("before-quit")?.({ preventDefault: () => undefined } as Electron.Event);
          const requestId = yield* Deferred.await(requested);
          assert.deepEqual(events, []);
          yield* capture.complete({ requestId, error: "IndexedDB commit failed" });
          yield* Deferred.await(recovered);
            yield* Effect.yieldNow;
          assert.isFalse(yield* Ref.get((yield* DesktopState.DesktopState).quitting));
          assert.deepEqual(events, []);
          assert.equal(errors.length, 1);
          appListeners.get("activate")?.();
          assert.deepEqual(events, ["activate"]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("cancels a failed relaunch and waits for a fresh capture commit before retrying", () =>
    Effect.gen(function* () {
      const firstRequest = yield* Deferred.make<string>();
      const secondRequest = yield* Deferred.make<string>();
      const recovered = yield* Deferred.make<void>();
      const exited = yield* Deferred.make<void>();
      let request = firstRequest;
      const events: string[] = [];
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(
          layerElectronApp(new Map(), Effect.void, {
            relaunch: () =>
              Effect.sync(() => {
                events.push("relaunch");
              }),
            exit: (code) =>
              Effect.sync(() => {
                events.push(`exit:${code}`);
              }).pipe(Effect.andThen(Deferred.succeed(exited, undefined)), Effect.asVoid),
          }),
        ),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(
          layerDesktopWindow({
            flushMainWindowBounds: Effect.sync(() => {
              events.push("bounds");
            }),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            platform: "darwin",
            isDevelopment: false,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopShutdown.DesktopShutdown, {
            request: Effect.sync(() => {
              events.push("shutdown");
            }),
            awaitRequest: Effect.void,
            markComplete: Effect.void,
            awaitComplete: Effect.void,
            isComplete: Effect.succeed(false),
          }),
        ),
        Layer.provideMerge(DesktopState.layer),
        Layer.provideMerge(DesktopCaptureShutdown.layer),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const capture = yield* DesktopCaptureShutdown.DesktopCaptureShutdown;
          yield* capture.register({
            request: (requestId) => Deferred.succeed(request, requestId).pipe(Effect.as(true)),
            release: (error) =>
              error === null
                ? Deferred.succeed(recovered, undefined).pipe(Effect.asVoid)
                : Effect.void,
          });
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.relaunch("test");
          const failedRequestId = yield* Deferred.await(firstRequest);
          yield* capture.complete({ requestId: failedRequestId, error: "voice stop failed" });
          yield* Deferred.await(recovered);
          assert.deepEqual(events, []);
          assert.isFalse(yield* Ref.get((yield* DesktopState.DesktopState).quitting));
          request = secondRequest;
          yield* lifecycle.relaunch("retry");
          const requestId = yield* Deferred.await(secondRequest);
          assert.deepEqual(events, []);
          assert.isFalse(yield* Deferred.isDone(exited));
          yield* capture.complete({ requestId, error: null });
          yield* Deferred.await(exited);
          assert.deepEqual(events, ["bounds", "shutdown", "relaunch", "exit:0"]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("ignores app activation while quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
      const activate = Effect.sync(() => {
        activationCount += 1;
      });
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow({ activate })),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        Layer.provideMerge(DesktopCaptureShutdown.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);

          appListeners.get("activate")?.();

          assert.equal(activationCount, 0);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
