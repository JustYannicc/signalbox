import { useCallback, useEffect, useRef, useState } from "react";

import { captureAppScreenshot } from "./captureScreenshot";

export type FeedbackScreenshot =
  | { readonly status: "idle" }
  | { readonly status: "capturing" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "failed" };

/**
 * One window capture at a time for the feedback popover. `start` captures the
 * current screen (called when the popover opens with the box checked), `clear`
 * drops it, and `resolve` waits for an in-flight capture so a quick submit
 * still carries the screenshot. A capture that finishes after `clear` or a
 * newer `start` is discarded.
 */
export function useFeedbackScreenshot() {
  const [screenshot, setScreenshot] = useState<FeedbackScreenshot>({ status: "idle" });
  const sessionRef = useRef(0);
  const pendingRef = useRef<Promise<Blob | null> | null>(null);
  const urlRef = useRef<string | null>(null);

  const releaseUrl = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const clear = useCallback(() => {
    sessionRef.current += 1;
    pendingRef.current = null;
    releaseUrl();
    setScreenshot({ status: "idle" });
  }, [releaseUrl]);

  const start = useCallback(() => {
    const session = ++sessionRef.current;
    releaseUrl();
    setScreenshot({ status: "capturing" });
    pendingRef.current = captureAppScreenshot().then(
      (blob) => {
        if (session === sessionRef.current) {
          urlRef.current = URL.createObjectURL(blob);
          setScreenshot({ status: "ready", url: urlRef.current });
        }
        return blob;
      },
      (error: unknown) => {
        console.warn("Feedback screenshot capture failed.", error);
        if (session === sessionRef.current) setScreenshot({ status: "failed" });
        return null;
      },
    );
  }, [releaseUrl]);

  const resolve = useCallback(() => pendingRef.current ?? Promise.resolve(null), []);

  // Unmounting (e.g. the mobile sidebar sheet closing) also orphans any
  // in-flight capture, so it can't create a URL nobody revokes.
  useEffect(
    () => () => {
      sessionRef.current += 1;
      pendingRef.current = null;
      releaseUrl();
    },
    [releaseUrl],
  );

  return { screenshot, start, clear, resolve };
}
