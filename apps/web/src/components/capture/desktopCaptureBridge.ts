import type { DesktopBridge } from "@t3tools/contracts";

type CaptureMethod =
  | "getCaptureState"
  | "setCaptureDestinations"
  | "submitCapture"
  | "listPendingCaptures"
  | "readCapture"
  | "acknowledgeCapture"
  | "reportCaptureFailure"
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
    !bridge.setCaptureDestinations ||
    !bridge.submitCapture ||
    !bridge.listPendingCaptures ||
    !bridge.readCapture ||
    !bridge.acknowledgeCapture ||
    !bridge.reportCaptureFailure ||
    !bridge.hideCapture ||
    !bridge.openCaptureMainWindow ||
    !bridge.checkCaptureShortcut ||
    !bridge.setCaptureShortcutSuppressed ||
    !bridge.onCaptureEvent
  )
    return null;
  return {
    getCaptureState: bridge.getCaptureState,
    setCaptureDestinations: bridge.setCaptureDestinations,
    submitCapture: bridge.submitCapture,
    listPendingCaptures: bridge.listPendingCaptures,
    readCapture: bridge.readCapture,
    acknowledgeCapture: bridge.acknowledgeCapture,
    reportCaptureFailure: bridge.reportCaptureFailure,
    hideCapture: bridge.hideCapture,
    openCaptureMainWindow: bridge.openCaptureMainWindow,
    checkCaptureShortcut: bridge.checkCaptureShortcut,
    setCaptureShortcutSuppressed: bridge.setCaptureShortcutSuppressed,
    onCaptureEvent: bridge.onCaptureEvent,
  };
}
