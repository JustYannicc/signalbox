import type { DesktopBridge } from "@t3tools/contracts";

type CaptureMethod =
  | "getCaptureState"
  | "beginCaptureDestinationSync"
  | "setCaptureDestinations"
  | "submitCapture"
  | "listPendingCaptures"
  | "readCapture"
  | "acknowledgeCapture"
  | "reportCaptureFailure"
  | "retryCaptureAtOwnerTop"
  | "completeCaptureFlush"
  | "hideCapture"
  | "openCaptureMainWindow"
  | "checkCaptureShortcut"
  | "setCaptureShortcutSuppressed"
  | "onCaptureEvent";
export type DesktopCaptureBridge = Required<Pick<DesktopBridge, CaptureMethod>>;

export function getDesktopCaptureBridge(): DesktopCaptureBridge | null {
  const bridge = window.desktopBridge;
  if (
    !bridge?.getCaptureState ||
    !bridge.beginCaptureDestinationSync ||
    !bridge.setCaptureDestinations ||
    !bridge.submitCapture ||
    !bridge.listPendingCaptures ||
    !bridge.readCapture ||
    !bridge.acknowledgeCapture ||
    !bridge.reportCaptureFailure ||
    !bridge.retryCaptureAtOwnerTop ||
    !bridge.completeCaptureFlush ||
    !bridge.hideCapture ||
    !bridge.openCaptureMainWindow ||
    !bridge.checkCaptureShortcut ||
    !bridge.setCaptureShortcutSuppressed ||
    !bridge.onCaptureEvent
  )
    return null;
  return {
    getCaptureState: bridge.getCaptureState,
    beginCaptureDestinationSync: bridge.beginCaptureDestinationSync,
    setCaptureDestinations: bridge.setCaptureDestinations,
    submitCapture: bridge.submitCapture,
    listPendingCaptures: bridge.listPendingCaptures,
    readCapture: bridge.readCapture,
    acknowledgeCapture: bridge.acknowledgeCapture,
    reportCaptureFailure: bridge.reportCaptureFailure,
    retryCaptureAtOwnerTop: bridge.retryCaptureAtOwnerTop,
    completeCaptureFlush: bridge.completeCaptureFlush,
    hideCapture: bridge.hideCapture,
    openCaptureMainWindow: bridge.openCaptureMainWindow,
    checkCaptureShortcut: bridge.checkCaptureShortcut,
    setCaptureShortcutSuppressed: bridge.setCaptureShortcutSuppressed,
    onCaptureEvent: bridge.onCaptureEvent,
  };
}
