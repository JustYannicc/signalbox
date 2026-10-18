import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type DesktopCapture,
  type DesktopCaptureDestination,
  type DesktopCaptureEvent,
  type DesktopCaptureId,
  type DesktopCaptureShortcutAvailability,
  type DesktopCaptureState,
  type DesktopPendingCapture,
  type DesktopSubmitCapture,
  SnapShotKeyChord,
} from "@t3tools/contracts";
import * as Electron from "electron";

import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import { toElectronAccelerator } from "../snapShot/snapShot.ts";
import * as CaptureQueue from "./CaptureQueue.ts";
import { dispatchCaptureShortcut, makeCaptureShortcutRegistration } from "./CaptureShortcut.ts";
import { CAPTURE_EVENT_CHANNEL } from "../ipc/channels.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";

export class DesktopQuickCapture extends Context.Service<
  DesktopQuickCapture,
  {
    readonly initialize: Effect.Effect<void>;
    readonly getState: Effect.Effect<DesktopCaptureState, CaptureQueue.CaptureQueueError>;
    readonly setDestinations: (
      destinations: ReadonlyArray<typeof DesktopCaptureDestination.Type>,
    ) => Effect.Effect<void, CaptureQueue.CaptureQueueError>;
    readonly submit: (
      capture: typeof DesktopSubmitCapture.Type,
    ) => Effect.Effect<typeof DesktopPendingCapture.Type, CaptureQueue.CaptureQueueError>;
    readonly listPending: Effect.Effect<
      ReadonlyArray<typeof DesktopPendingCapture.Type>,
      CaptureQueue.CaptureQueueError
    >;
    readonly read: (
      id: string,
    ) => Effect.Effect<typeof DesktopCapture.Type, CaptureQueue.CaptureQueueError>;
    readonly acknowledge: (id: string) => Effect.Effect<void, CaptureQueue.CaptureQueueError>;
    readonly reportFailure: (
      id: string,
      message: string,
    ) => Effect.Effect<void, CaptureQueue.CaptureQueueError>;
    readonly show: Effect.Effect<void>;
    readonly hide: Effect.Effect<void>;
    readonly openMainWindow: Effect.Effect<void, DesktopWindow.DesktopWindowError>;
    readonly checkShortcut: (
      shortcut: typeof DEFAULT_CLIENT_SETTINGS.captureGlobalShortcut,
    ) => Effect.Effect<typeof DesktopCaptureShortcutAvailability.Type>;
    readonly setShortcutSuppressed: (suppressed: boolean) => Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly isCapturePanelSender: (senderId: number, frameUrl: string) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/capture/DesktopQuickCapture") {}

const isSnapShotKeyChord = Schema.is(SnapShotKeyChord);
const CAPTURE_PANEL_WIDTH = 600;
const CAPTURE_PANEL_HEIGHT = 400;

function shortcutAccelerator(shortcut: ClientSettings["captureGlobalShortcut"]): string {
  return toElectronAccelerator(shortcut);
}

function capturePanelUrl(environment: DesktopEnvironment.DesktopEnvironment["Service"]): string {
  const url = new URL(getDesktopUrl(environment.isDevelopment));
  url.hash = "/capture";
  return url.href;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const queue = yield* CaptureQueue.CaptureQueue;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
  const settingsRef = yield* Ref.make(DEFAULT_CLIENT_SETTINGS);
  const context = yield* Effect.context<
    | CaptureQueue.CaptureQueue
    | DesktopClientSettings.DesktopClientSettings
    | DesktopEnvironment.DesktopEnvironment
    | DesktopWindow.DesktopWindow
    | ElectronWindow.ElectronWindow
    | DesktopSnapShot.DesktopSnapShot
  >();
  const runPromise = Effect.runPromiseWith(context);
  let captureWindow: Electron.BrowserWindow | undefined;
  let captureWindowLoaded = false;
  let captureWindowRequested = false;
  const shortcutRegistration = makeCaptureShortcutRegistration({
    register: (accelerator, listener) => Electron.globalShortcut.register(accelerator, listener),
    unregister: (accelerator) => Electron.globalShortcut.unregister(accelerator),
  });
  let shortcutMessage: string | null = null;
  let shortcutSuppressed = false;
  let applicationQuitting = false;

  const sendToCaptureWindow = (event: DesktopCaptureEvent) => {
    const window = captureWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(CAPTURE_EVENT_CHANNEL, event);
  };

  const sendToMain = (event: DesktopCaptureEvent, createHiddenIfMissing = false) =>
    desktopWindow.dispatchCaptureEvent(event, { createHiddenIfMissing }).pipe(Effect.ignoreCause);

  const placeCaptureWindow = (window: Electron.BrowserWindow) => {
    const display = Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint());
    const bounds = display.bounds;
    const width = Math.min(CAPTURE_PANEL_WIDTH, Math.max(420, bounds.width - 32));
    const height = Math.min(CAPTURE_PANEL_HEIGHT, Math.max(160, bounds.height - 32));
    window.setBounds({
      x: Math.round(bounds.x + (bounds.width - width) / 2),
      y: Math.round(bounds.y + bounds.height / 3 - height / 2),
      width,
      height,
    });
  };

  const presentCaptureWindow = (window: Electron.BrowserWindow) => {
    if (window.isDestroyed()) return;
    placeCaptureWindow(window);
    window.setAlwaysOnTop(true, "floating");
    if (environment.platform === "darwin") {
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    sendToCaptureWindow({ type: "shown" });
  };

  const createCaptureWindow = () => {
    if (captureWindow && !captureWindow.isDestroyed()) return captureWindow;
    const window = new Electron.BrowserWindow({
      width: CAPTURE_PANEL_WIDTH,
      height: CAPTURE_PANEL_HEIGHT,
      minWidth: 420,
      minHeight: 160,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      frame: false,
      backgroundColor: "#101010",
      title: "Quick capture",
      ...(environment.platform === "darwin" ? { type: "panel" as const } : {}),
      webPreferences: {
        preload: environment.preloadPath,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    captureWindow = window;
    captureWindowLoaded = false;
    window.webContents.on("did-finish-load", () => {
      if (captureWindow !== window || window.isDestroyed()) return;
      captureWindowLoaded = true;
      if (captureWindowRequested) {
        captureWindowRequested = false;
        presentCaptureWindow(window);
      }
    });
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key.toLowerCase() !== "w") return;
      const primaryModifier = environment.platform === "darwin" ? input.meta : input.control;
      if (primaryModifier && !input.alt && !input.shift) {
        event.preventDefault();
        sendToCaptureWindow({ type: "dismiss-requested" });
      }
    });
    window.on("close", (event) => {
      if (applicationQuitting) return;
      event.preventDefault();
      sendToCaptureWindow({ type: "dismiss-requested" });
    });
    window.on("closed", () => {
      if (captureWindow === window) {
        captureWindow = undefined;
        captureWindowLoaded = false;
        captureWindowRequested = false;
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void window.loadURL(capturePanelUrl(environment)).catch(() => undefined);
    return window;
  };

  const show = Effect.sync(() => {
    const window = createCaptureWindow();
    if (!captureWindowLoaded || window.webContents.isLoadingMainFrame()) {
      captureWindowRequested = true;
      return;
    }
    presentCaptureWindow(window);
  });

  const hide = Effect.sync(() => {
    const window = captureWindow;
    if (window && !window.isDestroyed()) window.hide();
  });

  const isCapturePanelSender = (senderId: number, frameUrl: string) =>
    Effect.sync(() => {
      const window = captureWindow;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
      if (window.webContents.id !== senderId) return false;
      try {
        const expected = new URL(capturePanelUrl(environment));
        const frame = new URL(frameUrl);
        return (
          frame.protocol === expected.protocol &&
          frame.host === expected.host &&
          frame.pathname === "/" &&
          frame.hash === "#/capture"
        );
      } catch {
        return false;
      }
    });

  const presentShortcut = () => {
    const focused = Electron.BrowserWindow.getFocusedWindow();
    return Effect.gen(function* () {
      const main = yield* electronWindow.main;
      const mainFocused =
        Option.isSome(main) && main.value === focused && !main.value.isDestroyed();
      dispatchCaptureShortcut({
        mainWindowFocused: mainFocused,
        dispatchMainAction: () => {
          void runPromise(
            desktopWindow.dispatchMenuAction("capture.open", { reveal: false }),
          ).catch(() => undefined);
        },
        showPanel: () => {
          void runPromise(show).catch(() => undefined);
        },
      });
    });
  };

  const configure = Effect.fn("desktop.quickCapture.configure")(function* (
    settings: ClientSettings,
  ) {
    yield* Ref.set(settingsRef, settings);
    if (environment.platform !== "darwin") {
      shortcutRegistration.stop();
      shortcutMessage = settings.captureGlobalShortcutEnabled
        ? "The global capture shortcut is available on macOS."
        : null;
      yield* sendToMain({ type: "shortcut-changed" });
      return;
    }
    const accelerator = shortcutAccelerator(settings.captureGlobalShortcut);
    const result = shortcutRegistration.configure({
      enabled: settings.captureGlobalShortcutEnabled,
      suppressed: shortcutSuppressed,
      accelerator,
      onTrigger: () => void runPromise(presentShortcut()).catch(() => undefined),
    });
    shortcutMessage = result.message;
    yield* sendToMain({ type: "shortcut-changed" });
  });

  const checkShortcut = Effect.fn("desktop.quickCapture.checkShortcut")(function* (
    shortcut: ClientSettings["captureGlobalShortcut"],
  ) {
    if (!isSnapShotKeyChord(shortcut)) {
      return { available: false, message: "Choose a shortcut with at least one modifier." };
    }
    const snapshotState = yield* snapShot.state;
    if (
      !("kind" in snapshotState.shortcut) &&
      shortcutAccelerator(snapshotState.shortcut) === shortcutAccelerator(shortcut)
    ) {
      return {
        available: false,
        message: "This shortcut is already used by the SnapShot capture shortcut.",
      };
    }
    const prior = shortcutRegistration.registeredAccelerator;
    shortcutRegistration.stop();
    const availability = yield* snapShot.checkShortcut(shortcut);
    if (prior !== undefined && !shortcutSuppressed) {
      const settings = yield* Ref.get(settingsRef);
      yield* configure(settings);
    }
    return availability;
  });

  const setShortcutSuppressed = Effect.fn("desktop.quickCapture.setShortcutSuppressed")(function* (
    suppressed: boolean,
  ) {
    shortcutSuppressed = suppressed;
    const settings = yield* Ref.get(settingsRef);
    yield* configure(settings);
  });

  const getState = Effect.gen(function* () {
    const destinations = yield* queue.destinations;
    const pending = yield* queue.listPending;
    const settings = yield* Ref.get(settingsRef);
    return {
      destinations,
      pending: pending.map(({ text: _text, ...capture }) => capture),
      shortcut: {
        enabled: settings.captureGlobalShortcutEnabled,
        shortcut: settings.captureGlobalShortcut,
        registered: shortcutRegistration.registeredAccelerator !== undefined,
        message: shortcutMessage,
      },
    } satisfies DesktopCaptureState;
  });

  const setDestinations = (destinations: ReadonlyArray<typeof DesktopCaptureDestination.Type>) =>
    queue
      .setDestinations(destinations)
      .pipe(
        Effect.andThen(Effect.sync(() => sendToCaptureWindow({ type: "destinations-changed" }))),
      );

  const submit = (capture: typeof DesktopSubmitCapture.Type) =>
    Effect.gen(function* () {
      const invalidFile = capture.files.find((file) => file.bytes.byteLength !== file.sizeBytes);
      if (invalidFile !== undefined) {
        return yield* Effect.fail(
          new CaptureQueue.CaptureQueueError({
            operation: "write-file",
            captureId: capture.id,
          }),
        );
      }
      if (capture.text.trim().length === 0 && capture.files.length === 0 && !capture.open) {
        return yield* Effect.fail(
          new CaptureQueue.CaptureQueueError({
            operation: "write-entry",
            captureId: capture.id,
          }),
        );
      }
      const pending = yield* queue.submit(capture);
      yield* sendToMain({ type: "queued", capture: pending }, true);
      return pending;
    });

  const acknowledge = (id: string) =>
    queue
      .acknowledge(id)
      .pipe(
        Effect.andThen(sendToMain({ type: "removed", id: id as DesktopCaptureId })),
        Effect.andThen(
          Effect.sync(() => sendToCaptureWindow({ type: "removed", id: id as DesktopCaptureId })),
        ),
      );

  const reportFailure = (id: string, message: string) =>
    queue.reportFailure(id, message).pipe(
      Effect.andThen(
        sendToMain({
          type: "delivery-error",
          id: id as DesktopCaptureId,
          message: message.slice(0, 2_000),
        }),
      ),
      Effect.andThen(
        Effect.sync(() =>
          sendToCaptureWindow({
            type: "delivery-error",
            id: id as DesktopCaptureId,
            message: message.slice(0, 2_000),
          }),
        ),
      ),
    );

  const initialize = Effect.gen(function* () {
    const saved = yield* clientSettings.get;
    yield* configure(Option.getOrElse(saved, () => DEFAULT_CLIENT_SETTINGS));
  }).pipe(Effect.ignore);

  const markApplicationQuitting = () => {
    applicationQuitting = true;
  };
  Electron.app.on("before-quit", markApplicationQuitting);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      applicationQuitting = true;
      shortcutRegistration.stop();
      if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy();
      Electron.app.removeListener("before-quit", markApplicationQuitting);
    }),
  );

  return DesktopQuickCapture.of({
    initialize,
    getState,
    setDestinations,
    submit,
    listPending: queue.listPending,
    read: queue.read,
    acknowledge,
    reportFailure,
    show,
    hide,
    openMainWindow: desktopWindow.activate,
    checkShortcut,
    setShortcutSuppressed,
    configure,
    isCapturePanelSender,
  });
});

export const layer = Layer.effect(DesktopQuickCapture, make);
