import { useAtomValue } from "@effect/atom-react";
import { captureDestinations } from "@t3tools/client-runtime/capture/destinations";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { getDesktopCaptureBridge } from "../capture/desktopCaptureBridge";
import { deliverDesktopCapture } from "../capture/deliverDesktopCapture";
import { useSaveCapture } from "../capture/useSaveCapture";
import { folderTreesAtom } from "../sidebar/folders/folderThreads";
import { toastManager } from "../ui/toast";

export function DesktopCaptureCoordinator() {
  const [bridge] = useState(getDesktopCaptureBridge);
  const trees = useAtomValue(folderTreesAtom);
  const destinations = captureDestinations(trees.values());
  const save = useSaveCapture();
  const running = useRef(false);
  const again = useRef(false);
  const mounted = useRef(false);
  const reported = useRef(new Map<string, string>());
  const drain = useEffectEvent(async function drainPending() {
    if (!bridge || !mounted.current || destinations.length === 0) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        const pending = await bridge.listPendingCaptures();
        for (const item of pending) {
          if (!mounted.current) break;
          try {
            await deliverDesktopCapture(bridge, item, destinations, save);
            reported.current.delete(item.id);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "Couldn't save this capture.";
            await bridge.reportCaptureFailure(item.id, message);
            if (reported.current.get(item.id) === message) continue;
            reported.current.set(item.id, message);
            toastManager.add({
              type: "error",
              title: "A capture is waiting to save",
              description: message,
              actionProps: {
                children: "Retry",
                onClick: () => {
                  void drainPending();
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

  useEffect(() => {
    if (!bridge) return;
    mounted.current = true;
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
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    void bridge
      .setCaptureDestinations(destinations)
      .then(() => drain())
      .catch((cause: unknown) => {
        toastManager.add({
          type: "error",
          title: "Couldn't update quick capture folders",
          description: cause instanceof Error ? cause.message : "Try again after reconnecting.",
        });
      });
  }, [bridge, destinations]);
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
