import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { captureDestinations } from "@t3tools/client-runtime/capture/destinations";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { environmentCatalog } from "../../connection/catalog";
import { environmentContextsAtom } from "../../state/signalboxContexts";
import { environmentFoldersAtom } from "../../state/signalboxFolders";
import { environmentServerConfigsAtom } from "../../state/server";
import { getDesktopCaptureBridge } from "../capture/desktopCaptureBridge";
import { deliverDesktopCapture } from "../capture/deliverDesktopCapture";
import { useSaveCapture } from "../capture/useSaveCapture";
import { folderTreesAtom } from "../sidebar/folders/folderThreads";
import { toastManager } from "../ui/toast";
import { captureFolderSnapshotsResolved, captureOwnerIsAvailable } from "./captureCoordinatorState";

interface DestinationState {
  readonly ready: boolean;
  readonly destinations: ReturnType<typeof captureDestinations>;
}

export function DesktopCaptureCoordinator() {
  const [bridge] = useState(getDesktopCaptureBridge);
  const trees = useAtomValue(folderTreesAtom);
  const destinations = captureDestinations(trees.values());
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const folders = useAtomValue(environmentFoldersAtom);
  const contexts = useAtomValue(environmentContextsAtom);
  const enabledIds = [...enabledEnvironmentIds(catalog)];
  const destinationsReady =
    catalog.isReady &&
    enabledIds.length > 0 &&
    enabledIds.every((environmentId) => serverConfigs.has(environmentId)) &&
    captureFolderSnapshotsResolved(folders, contexts);
  const save = useSaveCapture();
  const running = useRef(false);
  const again = useRef(false);
  const mounted = useRef(false);
  const reported = useRef(new Map<string, string>());
  const destinationState = useRef<DestinationState>({ ready: false, destinations });
  const destinationSyncStart = useRef<Promise<void> | null>(null);
  const ownersWereReady = useRef(false);
  const retryPending = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    destinationState.current = { ready: destinationsReady, destinations };
  }, [destinations, destinationsReady]);

  const drain = useStableCallback(async function drainPending() {
    const current = destinationState.current;
    if (!bridge || !mounted.current || !current.ready || current.destinations.length === 0) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        const pending = await bridge.listPendingCaptures();
        if (!mounted.current || !destinationState.current.ready) break;
        for (const item of pending) {
          const beforeDelivery = destinationState.current;
          if (!mounted.current || !beforeDelivery.ready) break;
          if (!captureOwnerIsAvailable(item.owner, beforeDelivery.destinations)) continue;
          try {
            await deliverDesktopCapture(
              bridge,
              item,
              () => (destinationState.current.ready ? destinationState.current.destinations : []),
              save,
            );
            reported.current.delete(item.id);
          } catch (cause) {
            const beforeReport = destinationState.current;
            if (
              !mounted.current ||
              !beforeReport.ready ||
              !captureOwnerIsAvailable(item.owner, beforeReport.destinations)
            )
              continue;
            const message = cause instanceof Error ? cause.message : "Couldn't save this capture.";
            try {
              await bridge.reportCaptureFailure(item.id, message);
            } catch (reportCause) {
              const afterReportFailure = destinationState.current;
              if (
                !afterReportFailure.ready ||
                !captureOwnerIsAvailable(item.owner, afterReportFailure.destinations)
              )
                continue;
              throw reportCause;
            }
            const afterReport = destinationState.current;
            if (
              !mounted.current ||
              !afterReport.ready ||
              !captureOwnerIsAvailable(item.owner, afterReport.destinations)
            )
              continue;
            if (reported.current.get(item.id) === message) continue;
            reported.current.set(item.id, message);
            toastManager.add({
              type: "error",
              title: "A capture is waiting to save",
              description: message,
              actionProps: {
                children: "Retry",
                onClick: () => {
                  retryPending.current();
                },
              },
            });
          }
        }
      } while (again.current && mounted.current);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't read saved captures",
        description: cause instanceof Error ? cause.message : "Try opening quick capture again.",
      });
    } finally {
      running.current = false;
    }
  });
  useLayoutEffect(() => {
    retryPending.current = () => void drain();
  }, [drain]);

  useEffect(() => {
    if (!bridge) return;
    mounted.current = true;
    const startingSync = bridge.beginCaptureDestinationSync();
    destinationSyncStart.current = startingSync;
    void startingSync.catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: "Couldn't prepare quick capture folders",
        description: cause instanceof Error ? cause.message : "Try opening quick capture again.",
      });
    });
    const retry = () => {
      void drain();
    };
    const unsubscribe = bridge.onCaptureEvent((event) => {
      if (event.type === "queued") retry();
    });
    window.addEventListener("focus", retry);
    return () => {
      mounted.current = false;
      unsubscribe();
      window.removeEventListener("focus", retry);
    };
  }, [bridge, drain]);

  useEffect(() => {
    if (!bridge) return;
    if (destinationsReady) {
      ownersWereReady.current = true;
      return;
    }
    if (!ownersWereReady.current) return;
    ownersWereReady.current = false;
    const restartingSync = bridge.beginCaptureDestinationSync();
    destinationSyncStart.current = restartingSync;
    void restartingSync.catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: "Couldn't prepare quick capture folders",
        description: cause instanceof Error ? cause.message : "Try opening quick capture again.",
      });
    });
  }, [bridge, destinationsReady]);

  useEffect(() => {
    if (!bridge || !destinationsReady) return;
    void (destinationSyncStart.current ?? Promise.resolve())
      .then(() => bridge.setCaptureDestinations(destinations))
      .then(() => drain())
      .catch((cause: unknown) => {
        toastManager.add({
          type: "error",
          title: "Couldn't update quick capture folders",
          description: cause instanceof Error ? cause.message : "Try again after reconnecting.",
        });
      });
  }, [bridge, destinations, destinationsReady, drain]);
  return null;
}

export function DesktopCaptureSignedOut() {
  useEffect(() => {
    void getDesktopCaptureBridge()
      ?.setCaptureDestinations([])
      .catch(() => undefined);
  }, []);
  return null;
}
