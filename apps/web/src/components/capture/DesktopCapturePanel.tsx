import type { DesktopCaptureState } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTheme } from "../../hooks/useTheme";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { getDesktopCaptureBridge } from "./desktopCaptureBridge";
import { QuickCaptureForm } from "./QuickCaptureForm";
import { CaptureDestinationUnavailableError, captureDestinationAvailable } from "./captureInput";
import type { Capture } from "./useSaveCapture";

export function DesktopCapturePanel() {
  useTheme();
  const [bridge] = useState(getDesktopCaptureBridge);
  const [state, setState] = useState<DesktopCaptureState | null>(null);
  const [captureStarted, setCaptureStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [captureId, setCaptureId] = useState(randomUUID);
  const [dismissRequest, setDismissRequest] = useState(0);
  const refreshId = useRef(0);

  function close() {
    if (!bridge) return;
    void bridge
      .hideCapture()
      .then(() => {
        setDismissRequest(0);
        setCaptureId(randomUUID());
        setCaptureStarted(false);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Couldn't hide capture."),
      );
  }

  function preserveClose() {
    void bridge
      ?.hideCapture()
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Couldn't hide capture."),
      );
  }

  const dismiss = useEffectEvent(() => {
    if (captureStarted) setDismissRequest((value) => value + 1);
    else close();
  });
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    const refresh = async () => {
      const id = ++refreshId.current;
      try {
        const next = await bridge.getCaptureState();
        if (mounted && id === refreshId.current) {
          setState(next);
          setLoadError(null);
          if (next.destinations.length > 0) setCaptureStarted(true);
        }
      } catch (cause) {
        if (mounted && id === refreshId.current)
          setLoadError(
            cause instanceof Error
              ? cause.message
              : "Couldn't load capture. Try opening Signalbox.",
          );
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", handleEscape);
    const unsubscribe = bridge.onCaptureEvent((event) => {
      if (event.type === "dismiss-requested") dismiss();
      else {
        void refresh();
        if (event.type === "shown")
          document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      }
    });
    void refresh();
    return () => {
      mounted = false;
      window.removeEventListener("keydown", handleEscape);
      unsubscribe();
    };
  }, [bridge]);

  const save = async (capture: Capture, open: boolean) => {
    if (!bridge) return false;
    const latest = await bridge.getCaptureState();
    setState(latest);
    if (!captureDestinationAvailable(capture.destination, latest.destinations)) {
      throw new CaptureDestinationUnavailableError();
    }
    await bridge.submitCapture({
      id: captureId,
      text: capture.text,
      destinationKey: capture.destination?.key ?? null,
      source: "quick-capture",
      open,
      files: await Promise.all(
        capture.files.map(async ({ id, file }) => ({
          id,
          name: file.name || "file",
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      ),
    });
    return true;
  };
  const openMain = () => {
    if (!bridge) return;
    void bridge
      .hideCapture()
      .then(() => bridge.openCaptureMainWindow())
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Couldn't open Signalbox."),
      );
  };
  const failures = state?.pending.filter((capture) => capture.deliveryError !== null) ?? [];
  return (
    <main
      className="dialog-glass flex h-dvh flex-col overflow-auto text-foreground"
      aria-label="Quick capture"
      data-quick-capture=""
    >
      {!bridge ? (
        <p className="p-4 text-sm">Open quick capture from Signalbox for Mac.</p>
      ) : state === null ? (
        <p role="status" className="p-4 text-sm">
          Loading capture…
        </p>
      ) : (
        <>
          {state.destinations.length === 0 ? (
            <div className="flex flex-col items-start gap-3 p-4">
              <p className="text-sm">Open Signalbox to sign in and load your folders.</p>
              <Button onClick={openMain}>Open Signalbox</Button>
            </div>
          ) : null}
          {captureStarted ? (
            <QuickCaptureForm
              key={captureId}
              destinations={state.destinations}
              dismissRequest={dismissRequest}
              onSave={save}
              onClose={close}
              requireDestination
              onPreserveClose={preserveClose}
            />
          ) : null}
        </>
      )}
      {error || loadError ? (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          {error ?? loadError}
        </p>
      ) : null}
      {failures.length > 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 px-4 pb-3">
          <p className="text-sm text-destructive">
            {failures.length === 1
              ? "A capture is waiting to save."
              : `${failures.length} captures are waiting to save.`}{" "}
            Your captures are kept on this Mac.
          </p>
          <p className="text-xs text-muted-foreground">{failures[0]?.deliveryError}</p>
          <Button size="sm" variant="outline" onClick={openMain}>
            Open Signalbox to retry
          </Button>
        </div>
      ) : null}
    </main>
  );
}
