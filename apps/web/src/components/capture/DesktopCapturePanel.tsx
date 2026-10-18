import type { DesktopCaptureState, DesktopCaptureSummary } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTheme } from "../../hooks/useTheme";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { getDesktopCaptureBridge } from "./desktopCaptureBridge";
import { desktopPanelDraftStorage, type DesktopPanelDraft } from "./desktopPanelDraft";
import { createCaptureFlush } from "./captureFlush";
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
  const [draft, setDraft] = useState<DesktopPanelDraft | null>(null);
  const [dismissRequest, setDismissRequest] = useState(0);
  const [flush] = useState(() => createCaptureFlush(() => desktopPanelDraftStorage().flush()));
  const [flushing, setFlushing] = useState(false);
  const flushLocked = useRef(false);
  const activeFlushes = useRef(0);
  const flushReleased = useRef(false);
  const refreshId = useRef(0);
  const retryId = useRef<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<{ id: string; message: string } | null>(null);

  function close() {
    if (!bridge) return;
    void desktopPanelDraftStorage()
      .write(null)
      .then(() => bridge.hideCapture())
      .then(() => {
        setDismissRequest(0);
        setCaptureId(randomUUID());
        setDraft(null);
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
    if (flushLocked.current) return;
    if (captureStarted) setDismissRequest((value) => value + 1);
    else close();
  });
  const flushForShutdown = useEffectEvent(async (requestId: string) => {
    if (!bridge) return;
    activeFlushes.current += 1;
    flushReleased.current = false;
    flushLocked.current = true;
    // Commit pending React input updates before reading the form; block edits until quit or release.
    flushSync(() => {
      setFlushing(true);
      setError(null);
    });
    let failure: string | null = null;
    try {
      await flush.run();
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : "Couldn't keep this capture on this Mac.";
      setError(failure);
      flushReleased.current = true;
    } finally {
      activeFlushes.current -= 1;
      if (activeFlushes.current === 0 && flushReleased.current) {
        flushLocked.current = false;
        setFlushing(false);
      }
    }
    try {
      await bridge.completeCaptureFlush({ requestId, error: failure?.slice(0, 2_000) ?? null });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn't confirm the capture was saved. Try quitting again.",
      );
      flushReleased.current = true;
      if (activeFlushes.current === 0) {
        flushLocked.current = false;
        setFlushing(false);
      }
    }
  });
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    let initialized = false;
    const initialDraft = Promise.resolve().then(() => desktopPanelDraftStorage().read());
    const refresh = async () => {
      const id = ++refreshId.current;
      try {
        const [next, restored] = await Promise.all([bridge.getCaptureState(), initialDraft]);
        if (mounted && id === refreshId.current) {
          if (!initialized) {
            initialized = true;
            setDraft(restored);
            if (restored) {
              setCaptureId(restored.id);
              setCaptureStarted(true);
            }
          }
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
      if (event.type === "flush-requested") void flushForShutdown(event.requestId);
      else if (event.type === "flush-released") {
        flushReleased.current = true;
        if (activeFlushes.current === 0) {
          flushLocked.current = false;
          setFlushing(false);
        }
        if (event.error) setError((current) => current ?? event.error);
      } else if (event.type === "dismiss-requested") dismiss();
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
  const failures =
    state?.pending.filter(
      (capture) =>
        capture.deliveryError !== null &&
        capture.owner !== undefined &&
        state.destinations.some(
          (destination) =>
            destination.environmentId === capture.owner?.environmentId &&
            destination.ownerProjectId === capture.owner?.ownerProjectId,
        ),
    ) ?? [];
  const retryAtTop = async (capture: DesktopCaptureSummary) => {
    if (!bridge || retryId.current !== null) return;
    retryId.current = capture.id;
    setRetryingId(capture.id);
    setRetryError(null);
    try {
      await bridge.retryCaptureAtOwnerTop(capture.id);
    } catch (cause) {
      setRetryError({
        id: capture.id,
        message:
          cause instanceof Error
            ? cause.message
            : "Couldn't retry. Open Signalbox to reconnect this account.",
      });
    } finally {
      retryId.current = null;
      setRetryingId(null);
    }
  };
  return (
    <main
      className="dialog-glass flex h-dvh flex-col overflow-auto text-foreground"
      aria-label="Quick capture"
      data-quick-capture=""
      aria-busy={flushing}
    >
      <div className="contents" inert={flushing}>
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
                initialCapture={draft?.capture ?? null}
                dismissRequest={dismissRequest}
                registerFlush={flush.register}
                onDraftChange={(capture) =>
                  desktopPanelDraftStorage().write({ id: captureId, capture })
                }
                onSave={save}
                onClose={close}
                requireDestination
                onPreserveClose={preserveClose}
              />
            ) : null}
          </>
        )}
        {failures.length > 0 ? (
          <div role="alert" className="flex flex-col items-start gap-2 px-4 pb-3">
            <p className="text-sm text-destructive">
              {failures.length === 1
                ? "A capture is waiting to save."
                : `${failures.length} captures are waiting to save.`}{" "}
              Your captures are kept on this Mac.
            </p>
            {failures.map((capture) => {
              const topAvailable = state?.destinations.some(
                (destination) =>
                  destination.folderId === null &&
                  destination.environmentId === capture.owner?.environmentId &&
                  destination.ownerProjectId === capture.owner?.ownerProjectId,
              );
              return (
                <div key={capture.id} className="flex w-full flex-col items-start gap-2">
                  <p className="line-clamp-2 break-words text-sm">
                    {capture.text?.trim() || "Capture"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {retryError?.id === capture.id ? retryError.message : capture.deliveryError}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={retryingId !== null || !topAvailable}
                    onClick={() => void retryAtTop(capture)}
                  >
                    {retryingId === capture.id ? "Retrying…" : "Retry at top level"}
                  </Button>
                  {!topAvailable ? (
                    <p className="text-xs text-muted-foreground">
                      Open Signalbox to load this account's top level.
                    </p>
                  ) : null}
                </div>
              );
            })}
            <Button size="sm" variant="outline" onClick={openMain}>
              Open Signalbox to retry
            </Button>
          </div>
        ) : null}
      </div>
      {flushing ? (
        <p role="status" className="px-4 pb-3 text-sm">
          Saving capture before closing…
        </p>
      ) : null}
      {error || loadError ? (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          {error ?? loadError}
        </p>
      ) : null}
    </main>
  );
}
