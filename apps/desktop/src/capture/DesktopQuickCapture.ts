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
  type DesktopCaptureOwner,
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
import * as DesktopCaptureShutdown from "./DesktopCaptureShutdown.ts";
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
    ) => Effect.Effect<
      typeof DesktopPendingCapture.Type,
      CaptureQueue.CaptureQueueError | CaptureQueue.CaptureDestinationUnavailableError
    >;
    readonly beginDestinationSync: Effect.Effect<void>;
    readonly retryAtOwnerTop: (
      id: string,
    ) => Effect.Effect<
      typeof DesktopPendingCapture.Type,
      CaptureQueue.CaptureQueueError | CaptureQueue.CaptureDestinationUnavailableError
    >;
    readonly listPending: Effect.Effect<
      ReadonlyArray<typeof DesktopPendingCapture.Type>,
      CaptureQueue.CaptureQueueError
    >;
    readonly read: (
      id: string,
    ) => Effect.Effect<
      typeof DesktopCapture.Type,
      CaptureQueue.CaptureQueueError | CaptureQueue.CaptureDestinationUnavailableError
    >;
    readonly acknowledge: (
      id: string,
    ) => Effect.Effect<
      void,
      CaptureQueue.CaptureQueueError | CaptureQueue.CaptureDestinationUnavailableError
    >;
    readonly reportFailure: (
      id: string,
      message: string,
    ) => Effect.Effect<
      void,
      CaptureQueue.CaptureQueueError | CaptureQueue.CaptureDestinationUnavailableError
    >;
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

function sameCaptureOwner(
  left: DesktopCaptureOwner | undefined,
  right: DesktopCaptureOwner,
): boolean {
  return (
    left !== undefined &&
    left.environmentId === right.environmentId &&
    left.ownerProjectId === right.ownerProjectId
  );
}

function captureOwners(destinations: ReadonlyArray<DesktopCaptureDestination>) {
  const owners: DesktopCaptureOwner[] = [];
  for (const destination of destinations) {
    const owner = {
      environmentId: destination.environmentId,
      ownerProjectId: destination.ownerProjectId,
    };
    if (!owners.some((candidate) => sameCaptureOwner(candidate, owner))) owners.push(owner);
  }
  return owners;
}

function belongsToCaptureOwners(
  owner: DesktopCaptureOwner | undefined,
  owners: ReadonlyArray<DesktopCaptureOwner> | null,
): boolean {
  return (
    owners !== null &&
    owner !== undefined &&
    owners.some((candidate) => sameCaptureOwner(owner, candidate))
  );
}

function ownersWithCurrentDestinations(
  owners: ReadonlyArray<DesktopCaptureOwner> | null,
  destinations: ReadonlyArray<DesktopCaptureDestination>,
): ReadonlyArray<DesktopCaptureOwner> {
  if (owners === null) return [];
  return owners.filter((owner) =>
    destinations.some((destination) => sameCaptureOwner(destination, owner)),
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const queue = yield* CaptureQueue.CaptureQueue;
  const captureShutdown = yield* DesktopCaptureShutdown.DesktopCaptureShutdown;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
  const settingsRef = yield* Ref.make(DEFAULT_CLIENT_SETTINGS);
  // `null` means this renderer has not resolved its signed-in folder snapshots yet.
  const activeOwnersRef = yield* Ref.make<ReadonlyArray<DesktopCaptureOwner> | null>(null);
  const destinationSyncGenerationRef = yield* Ref.make(0);
  const context = yield* Effect.context<
    | CaptureQueue.CaptureQueue
    | DesktopCaptureShutdown.DesktopCaptureShutdown
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
  let pendingCaptureFlushRelease:
    | { readonly window: Electron.BrowserWindow | null; readonly error: string | null }
    | undefined;
  const flushRequestCleanups = new Map<string, () => void>();
  const shortcutRegistration = makeCaptureShortcutRegistration({
    register: (accelerator, listener) => Electron.globalShortcut.register(accelerator, listener),
    unregister: (accelerator) => Electron.globalShortcut.unregister(accelerator),
  });
  let shortcutMessage: string | null = null;
  let shortcutSuppressed = false;
  let applicationQuitting = false;
  let captureFlushPending = false;

  const sendToCaptureWindow = (event: DesktopCaptureEvent) => {
    const window = captureWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(CAPTURE_EVENT_CHANNEL, event);
  };

  const sendToMain = (event: DesktopCaptureEvent, createHiddenIfMissing = false) =>
    desktopWindow.dispatchCaptureEvent(event, { createHiddenIfMissing }).pipe(Effect.ignoreCause);

  const isLiveCaptureWindow = (window: Electron.BrowserWindow | undefined): boolean =>
    Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed());

  const queueCaptureFlushRelease = (window: Electron.BrowserWindow, error: string | null) => {
    const retainedError = error ?? pendingCaptureFlushRelease?.error ?? null;
    pendingCaptureFlushRelease = { window, error: retainedError };
    return retainedError;
  };

  const reportCaptureFlushFailure = (requestId: string, error: string) => {
    void runPromise(captureShutdown.complete({ requestId, error })).catch(() => undefined);
  };

  const requestCaptureFlush = (requestId: string) =>
    Effect.sync(() => {
      captureFlushPending = true;
      captureWindowRequested = false;
      const window = captureWindow;
      if (!window) return false;
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        reportCaptureFlushFailure(requestId, "Quick capture stopped before it finished saving.");
        return true;
      }

      let dispatched = false;
      let cleanup = () => {};
      const fail = (message: string) => {
        cleanup();
        reportCaptureFlushFailure(requestId, message);
      };
      const onClosed = () => fail("Quick capture closed before it finished saving.");
      const onRenderProcessGone = () => fail("Quick capture stopped before it finished saving.");
      const onDidFailLoad = (
        _event: Electron.Event,
        _errorCode: number,
        _errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame) fail("Quick capture couldn't load before it finished saving.");
      };
      const sendRequest = () => {
        if (dispatched) return;
        dispatched = true;
        window.webContents.removeListener("did-finish-load", onDidFinishLoad);
        window.webContents.removeListener("did-fail-load", onDidFailLoad);
        if (captureWindow !== window || window.isDestroyed() || window.webContents.isDestroyed()) {
          fail("Quick capture closed before it finished saving.");
          return;
        }
        try {
          window.webContents.send(CAPTURE_EVENT_CHANNEL, { type: "flush-requested", requestId });
        } catch {
          fail("Quick capture stopped before it finished saving.");
        }
      };
      const onDidFinishLoad = () => sendRequest();
      cleanup = () => {
        window.webContents.removeListener("did-finish-load", onDidFinishLoad);
        window.webContents.removeListener("did-fail-load", onDidFailLoad);
        window.webContents.removeListener("render-process-gone", onRenderProcessGone);
        window.removeListener("closed", onClosed);
        flushRequestCleanups.delete(requestId);
      };

      flushRequestCleanups.set(requestId, cleanup);
      window.on("closed", onClosed);
      window.webContents.on("render-process-gone", onRenderProcessGone);
      if (captureWindowLoaded && !window.webContents.isLoadingMainFrame()) {
        sendRequest();
      } else {
        window.webContents.on("did-finish-load", onDidFinishLoad);
        window.webContents.on("did-fail-load", onDidFailLoad);
      }
      return true;
    });

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
    if (captureWindow && isLiveCaptureWindow(captureWindow)) return captureWindow;
    if (captureWindow && !captureWindow.isDestroyed() && captureWindow.webContents.isDestroyed()) {
      captureWindow.destroy();
    }
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
    if (pendingCaptureFlushRelease?.window === null) {
      const pendingRelease = pendingCaptureFlushRelease;
      pendingCaptureFlushRelease = { ...pendingRelease, window };
    }
    window.webContents.on("did-finish-load", () => {
      if (captureWindow !== window || window.isDestroyed()) return;
      captureWindowLoaded = true;
      if (captureWindowRequested) {
        captureWindowRequested = false;
        presentCaptureWindow(window);
      }
      const pendingRelease = pendingCaptureFlushRelease;
      if (pendingRelease?.window === window) {
        try {
          window.webContents.send(CAPTURE_EVENT_CHANNEL, {
            type: "flush-released",
            error: pendingRelease.error,
          });
          if (pendingCaptureFlushRelease === pendingRelease) pendingCaptureFlushRelease = undefined;
        } catch {
          if (!isLiveCaptureWindow(window)) {
            if (pendingRelease.error !== null) {
              const replacement = createCaptureWindow();
              queueCaptureFlushRelease(replacement, pendingRelease.error);
              captureWindowRequested = true;
            } else {
              pendingCaptureFlushRelease = undefined;
            }
          }
        }
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
      if (pendingCaptureFlushRelease?.window === window) {
        pendingCaptureFlushRelease =
          pendingCaptureFlushRelease.error === null
            ? undefined
            : { window: null, error: pendingCaptureFlushRelease.error };
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void window.loadURL(capturePanelUrl(environment)).catch(() => undefined);
    return window;
  };

  const show = Effect.sync(() => {
    if (captureFlushPending) return;
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

  const releaseCaptureFlush = (error: string | null) =>
    Effect.gen(function* () {
      applicationQuitting = false;
      captureFlushPending = false;
      for (const cleanup of [...flushRequestCleanups.values()]) cleanup();

      let window = captureWindow;
      const releaseError = error ?? pendingCaptureFlushRelease?.error ?? null;
      if (releaseError !== null && !isLiveCaptureWindow(window)) {
        window = yield* Effect.sync(createCaptureWindow);
      }
      let shouldReveal = releaseError !== null;
      if (window && isLiveCaptureWindow(window)) {
        if (captureWindowLoaded && !window.webContents.isLoadingMainFrame()) {
          try {
            window.webContents.send(CAPTURE_EVENT_CHANNEL, {
              type: "flush-released",
              error: releaseError,
            });
            if (pendingCaptureFlushRelease?.error === releaseError) {
              pendingCaptureFlushRelease = undefined;
            }
          } catch {
            shouldReveal = true;
            if (!isLiveCaptureWindow(window)) {
              if (releaseError !== null) {
                window = yield* Effect.sync(createCaptureWindow);
                queueCaptureFlushRelease(window, releaseError);
              }
            } else {
              queueCaptureFlushRelease(window, releaseError);
            }
          }
        } else {
          queueCaptureFlushRelease(window, releaseError);
        }
      }
      if (shouldReveal) yield* show;
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
    if (captureFlushPending) return Effect.void;
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
    const initialOwners = yield* Ref.get(activeOwnersRef);
    const storedDestinations = initialOwners === null ? [] : yield* queue.destinations;
    const pending = initialOwners === null ? [] : yield* queue.listPending;
    const activeOwners = ownersWithCurrentDestinations(
      yield* Ref.get(activeOwnersRef),
      storedDestinations,
    );
    const destinations = storedDestinations.filter((destination) =>
      belongsToCaptureOwners(destination, activeOwners),
    );
    const visiblePending = pending.filter((capture) =>
      belongsToCaptureOwners(capture.owner, activeOwners),
    );
    const settings = yield* Ref.get(settingsRef);
    return {
      destinations,
      pending: visiblePending.map((capture) => ({
        ...capture,
        text: capture.text.slice(0, 120),
      })),
      shortcut: {
        enabled: settings.captureGlobalShortcutEnabled,
        shortcut: settings.captureGlobalShortcut,
        registered: shortcutRegistration.registeredAccelerator !== undefined,
        message: shortcutMessage,
      },
    } satisfies DesktopCaptureState;
  });

  const beginDestinationSync = Effect.gen(function* () {
    yield* Ref.update(destinationSyncGenerationRef, (generation) => generation + 1);
    yield* Ref.set(activeOwnersRef, null);
    yield* Effect.sync(() => sendToCaptureWindow({ type: "destinations-changed" }));
  });

  const setDestinations = (destinations: ReadonlyArray<typeof DesktopCaptureDestination.Type>) =>
    Effect.gen(function* () {
      const generation = yield* Ref.get(destinationSyncGenerationRef);
      yield* queue.setDestinations(destinations);
      if ((yield* Ref.get(destinationSyncGenerationRef)) !== generation) return;
      yield* Ref.set(activeOwnersRef, captureOwners(destinations));
      yield* Effect.sync(() => sendToCaptureWindow({ type: "destinations-changed" }));
    });

  const submit = (capture: typeof DesktopSubmitCapture.Type) =>
    Effect.gen(function* () {
      const owners = yield* Ref.get(activeOwnersRef);
      if (owners === null)
        return yield* Effect.fail(
          new CaptureQueue.CaptureDestinationUnavailableError({ captureId: capture.id }),
        );
      const destinations = yield* queue.destinations;
      const destination = destinations.find(
        (item) => item.key === capture.destinationKey && capture.destinationKey !== null,
      );
      if (!belongsToCaptureOwners(destination, owners))
        return yield* Effect.fail(
          new CaptureQueue.CaptureDestinationUnavailableError({ captureId: capture.id }),
        );
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
      const latestOwners = yield* Ref.get(activeOwnersRef);
      if (!belongsToCaptureOwners(pending.owner, latestOwners)) return pending;
      yield* sendToMain({ type: "queued", capture: pending }, true);
      return pending;
    });

  const currentPendingCapture = (id: string) =>
    Effect.gen(function* () {
      const owners = yield* Ref.get(activeOwnersRef);
      if (owners === null) return null;
      const [destinations, pending] = yield* Effect.all([queue.destinations, queue.listPending]);
      const currentOwners = ownersWithCurrentDestinations(
        yield* Ref.get(activeOwnersRef),
        destinations,
      );
      return (
        pending.find(
          (capture) => capture.id === id && belongsToCaptureOwners(capture.owner, currentOwners),
        ) ?? null
      );
    });

  const listPending = Effect.gen(function* () {
    const owners = yield* Ref.get(activeOwnersRef);
    if (owners === null) return [];
    const [destinations, pending] = yield* Effect.all([queue.destinations, queue.listPending]);
    const currentOwners = ownersWithCurrentDestinations(
      yield* Ref.get(activeOwnersRef),
      destinations,
    );
    return pending.filter((capture) => belongsToCaptureOwners(capture.owner, currentOwners));
  });

  const read = (id: string) =>
    Effect.gen(function* () {
      const capture = yield* queue.read(id);
      const owners = yield* Ref.get(activeOwnersRef);
      const destinations = owners === null ? [] : yield* queue.destinations;
      const currentOwners = ownersWithCurrentDestinations(
        yield* Ref.get(activeOwnersRef),
        destinations,
      );
      if (!belongsToCaptureOwners(capture.owner, currentOwners))
        return yield* Effect.fail(
          new CaptureQueue.CaptureDestinationUnavailableError({ captureId: id }),
        );
      return capture;
    });

  const acknowledge = (id: string) =>
    Effect.gen(function* () {
      if ((yield* currentPendingCapture(id)) === null)
        return yield* Effect.fail(
          new CaptureQueue.CaptureDestinationUnavailableError({ captureId: id }),
        );
      yield* queue.acknowledge(id);
      yield* sendToMain({ type: "removed", id: id as DesktopCaptureId });
      yield* Effect.sync(() =>
        sendToCaptureWindow({ type: "removed", id: id as DesktopCaptureId }),
      );
    });

  const reportFailure = (id: string, message: string) =>
    Effect.gen(function* () {
      if ((yield* currentPendingCapture(id)) === null)
        return yield* Effect.fail(
          new CaptureQueue.CaptureDestinationUnavailableError({ captureId: id }),
        );
      yield* queue.reportFailure(id, message);
      if ((yield* currentPendingCapture(id)) === null) return;
      yield* sendToMain({
        type: "delivery-error",
        id: id as DesktopCaptureId,
        message: message.slice(0, 2_000),
      });
      yield* Effect.sync(() =>
        sendToCaptureWindow({
          type: "delivery-error",
          id: id as DesktopCaptureId,
          message: message.slice(0, 2_000),
        }),
      );
    });

  const retryAtOwnerTop = Effect.fn("desktop.quickCapture.retryAtOwnerTop")(function* (id: string) {
    if ((yield* currentPendingCapture(id)) === null)
      return yield* Effect.fail(
        new CaptureQueue.CaptureDestinationUnavailableError({ captureId: id }),
      );
    const pending = yield* queue.retryAtOwnerTop(id);
    if ((yield* currentPendingCapture(id)) === null) return pending;
    yield* sendToMain({ type: "queued", capture: pending }, true);
    yield* Effect.sync(() => sendToCaptureWindow({ type: "queued", capture: pending }));
    return pending;
  });

  const initialize = Effect.gen(function* () {
    const saved = yield* clientSettings.get;
    yield* configure(Option.getOrElse(saved, () => DEFAULT_CLIENT_SETTINGS));
  }).pipe(Effect.ignore);

  const updateApplicationQuitting = (event: Electron.Event) => {
    queueMicrotask(() => {
      applicationQuitting = !event.defaultPrevented;
    });
  };
  Electron.app.on("before-quit", updateApplicationQuitting);
  yield* captureShutdown.register({
    request: requestCaptureFlush,
    release: releaseCaptureFlush,
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      applicationQuitting = true;
      shortcutRegistration.stop();
      if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy();
      Electron.app.removeListener("before-quit", updateApplicationQuitting);
    }),
  );

  return DesktopQuickCapture.of({
    initialize,
    getState,
    beginDestinationSync,
    setDestinations,
    submit,
    listPending,
    read,
    acknowledge,
    reportFailure,
    retryAtOwnerTop,
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
