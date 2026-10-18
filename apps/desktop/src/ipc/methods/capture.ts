import {
  DesktopCapture,
  DesktopCaptureDestination,
  DesktopCaptureId,
  DesktopCaptureState,
  DesktopCaptureShortcutAvailability,
  DesktopCaptureShortcutState,
  DesktopPendingCapture,
  DesktopSubmitCapture,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopQuickCapture from "../../capture/DesktopQuickCapture.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class CaptureIpcUnauthorizedSenderError extends Schema.TaggedError<CaptureIpcUnauthorizedSenderError>()(
  "CaptureIpcUnauthorizedSenderError",
  { role: Schema.Literals(["main", "panel"]) },
) {
  override get message(): string {
    return "Capture request was rejected.";
  }
}

function isApplicationFrame(
  url: string,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): boolean {
  try {
    const expected = new URL(`signalbox${environment.isDevelopment ? "-dev" : ""}://app/`);
    const frame = new URL(url);
    return frame.protocol === expected.protocol && frame.host === expected.host;
  } catch {
    return false;
  }
}

const ensureMainSender = Effect.fn("desktop.ipc.capture.ensureMainSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const main = yield* electronWindow.main;
  const frame = event?.senderFrame;
  if (
    event === undefined ||
    frame == null ||
    frame.parent !== null ||
    Option.isNone(main) ||
    main.value.isDestroyed() ||
    main.value.webContents.isDestroyed() ||
    main.value.webContents.id !== event.sender.id ||
    !isApplicationFrame(frame.url, environment) ||
    new URL(frame.url).hash === "#/capture"
  ) {
    return yield* new CaptureIpcUnauthorizedSenderError({ role: "main" });
  }
  return main.value;
});

const ensureCapturePanelSender = Effect.fn("desktop.ipc.capture.ensurePanelSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const quickCapture = yield* DesktopQuickCapture.DesktopQuickCapture;
  const frame = event?.senderFrame;
  if (
    event === undefined ||
    frame == null ||
    frame.parent !== null ||
    !(yield* quickCapture.isCapturePanelSender(event.sender.id, frame.url))
  ) {
    return yield* new CaptureIpcUnauthorizedSenderError({ role: "panel" });
  }
});

const ensureMainOrPanelSender = Effect.fn("desktop.ipc.capture.ensureMainOrPanelSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const quickCapture = yield* DesktopQuickCapture.DesktopQuickCapture;
  const frame = event?.senderFrame;
  if (
    event === undefined ||
    frame == null ||
    frame.parent !== null ||
    !isApplicationFrame(frame.url, yield* DesktopEnvironment.DesktopEnvironment) ||
    (!(yield* quickCapture.isCapturePanelSender(event.sender.id, frame.url)) &&
      Option.match(yield* (yield* ElectronWindow.ElectronWindow).main, {
        onNone: () => false,
        onSome: (window) =>
          !window.isDestroyed() &&
          !window.webContents.isDestroyed() &&
          window.webContents.id === event.sender.id &&
          new URL(frame.url).hash !== "#/capture",
      }) === false)
  ) {
    return yield* new CaptureIpcUnauthorizedSenderError({ role: "main" });
  }
});

export const getCaptureState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CAPTURE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopCaptureState,
  handler: Effect.fn("desktop.ipc.capture.getState")(function* (_, event) {
    yield* ensureMainOrPanelSender(event);
    return yield* (yield* DesktopQuickCapture.DesktopQuickCapture).getState;
  }),
});

export const setCaptureDestinations = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CAPTURE_DESTINATIONS_CHANNEL,
  payload: Schema.Array(DesktopCaptureDestination).check(Schema.isMaxLength(2_000)),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.capture.setDestinations")(function* (destinations, event) {
    yield* ensureMainSender(event);
    yield* (yield* DesktopQuickCapture.DesktopQuickCapture).setDestinations(destinations);
  }),
});

export const submitCapture = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SUBMIT_CAPTURE_CHANNEL,
  payload: DesktopSubmitCapture,
  result: DesktopPendingCapture,
  handler: Effect.fn("desktop.ipc.capture.submit")(function* (capture, event) {
    yield* ensureCapturePanelSender(event);
    return yield* (yield* DesktopQuickCapture.DesktopQuickCapture).submit(capture);
  }),
});

export const listPendingCaptures = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_PENDING_CAPTURES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopPendingCapture),
  handler: Effect.fn("desktop.ipc.capture.listPending")(function* (_, event) {
    yield* ensureMainSender(event);
    return yield* (yield* DesktopQuickCapture.DesktopQuickCapture).listPending;
  }),
});

export const readCapture = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_CAPTURE_CHANNEL,
  payload: DesktopCaptureId,
  result: DesktopCapture,
  handler: Effect.fn("desktop.ipc.capture.read")(function* (id, event) {
    yield* ensureMainSender(event);
    return yield* (yield* DesktopQuickCapture.DesktopQuickCapture).read(id);
  }),
});

export const acknowledgeCapture = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ACKNOWLEDGE_CAPTURE_CHANNEL,
  payload: DesktopCaptureId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.capture.acknowledge")(function* (id, event) {
    yield* ensureMainSender(event);
    yield* (yield* DesktopQuickCapture.DesktopQuickCapture).acknowledge(id);
  }),
});

export const reportCaptureFailure = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REPORT_CAPTURE_FAILURE_CHANNEL,
  payload: Schema.Struct({
    id: DesktopCaptureId,
    message: Schema.String.check(Schema.isMaxLength(2_000)),
  }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.capture.reportFailure")(function* ({ id, message }, event) {
    yield* ensureMainSender(event);
    yield* (yield* DesktopQuickCapture.DesktopQuickCapture).reportFailure(id, message);
  }),
});

export const hideCapture = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.HIDE_CAPTURE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.capture.hide")(function* (_, event) {
    yield* ensureCapturePanelSender(event);
    yield* (yield* DesktopQuickCapture.DesktopQuickCapture).hide;
  }),
});

export const openCaptureMainWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_CAPTURE_MAIN_WINDOW_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.capture.openMainWindow")(function* (_, event) {
    yield* ensureMainOrPanelSender(event);
    yield* (yield* DesktopQuickCapture.DesktopQuickCapture).openMainWindow;
  }),
});

export const checkCaptureShortcut = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CHECK_CAPTURE_SHORTCUT_CHANNEL,
  payload: DesktopCaptureShortcutState.fields.shortcut,
  result: DesktopCaptureShortcutAvailability,
  handler: Effect.fn("desktop.ipc.capture.checkShortcut")(function* (shortcut, event) {
    yield* ensureMainSender(event);
    return yield* (yield* DesktopQuickCapture.DesktopQuickCapture).checkShortcut(shortcut);
  }),
});

export const setCaptureShortcutSuppressed = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CAPTURE_SHORTCUT_SUPPRESSED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.capture.setShortcutSuppressed")(function* (suppressed, event) {
    yield* ensureMainSender(event);
    yield* (yield* DesktopQuickCapture.DesktopQuickCapture).setShortcutSuppressed(suppressed);
  }),
});
