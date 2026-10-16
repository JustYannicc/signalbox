import { LockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

/** How long the live view gets to show its first frame before it's reloaded once. */
const WATCHDOG_MS = 15_000;

type FrameState = "connecting" | "playing" | "failed";

/**
 * A provider sign-in running in a cloud browser (#205), embedded through the
 * browser's live view. The person signs in here; the cloud catches the
 * provider's redirect and adds the account, so nothing is copied or pasted.
 * Kernel's live view posts `KERNEL_PLAYING` once frames render, and a stall
 * gets one reload before it says so.
 */
export function LiveSignInFrame({
  url,
  site,
  account,
}: {
  readonly url: string;
  /** Where the person is signing in, such as `claude.ai`. */
  readonly site: string;
  /** "Claude" or "ChatGPT". */
  readonly account: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Each load of the live view is an attempt; a reload starts the next one connecting.
  const [{ attempt, state }, setFrame] = useState<{ attempt: number; state: FrameState }>({
    attempt: 0,
    state: "connecting",
  });
  const reload = () => setFrame({ attempt: attempt + 1, state: "connecting" });

  useEffect(() => {
    const origin = new URL(url).origin;
    // One silent reload for a stall, then it says so.
    const watchdog = window.setTimeout(() => {
      if (attempt === 0) setFrame({ attempt: 1, state: "connecting" });
      else setFrame((frame) => ({ ...frame, state: "failed" }));
    }, WATCHDOG_MS);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const type: unknown = event.data?.type;
      if (type === "KERNEL_PLAYING") {
        window.clearTimeout(watchdog);
        setFrame((frame) => (frame.state === "playing" ? frame : { ...frame, state: "playing" }));
      } else if (type === "KERNEL_CONNECTION_FAILED" || type === "KERNEL_CONNECTION_TIMEOUT") {
        window.clearTimeout(watchdog);
        setFrame((frame) => (frame.state === "failed" ? frame : { ...frame, state: "failed" }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.clearTimeout(watchdog);
      window.removeEventListener("message", onMessage);
    };
  }, [url, attempt]);

  return (
    <div className="flex flex-col items-center gap-2 px-3 pt-1 pb-3 sm:px-4">
      <div
        className="relative aspect-390/844 h-[min(42rem,calc(100dvh-17rem))] min-h-80 overflow-hidden rounded-lg border border-border bg-muted"
        // Safari only sends keys to an iframe focused from a person's own action.
        onPointerDown={() => frameRef.current?.focus()}
      >
        <iframe
          key={attempt}
          ref={frameRef}
          src={url}
          title={`${account} sign-in`}
          allow="autoplay; clipboard-read; clipboard-write"
          // oxlint-disable-next-line react/iframe-missing-sandbox -- Kernel's live view player needs scripts and its own origin for its stream and input.
          sandbox="allow-scripts allow-same-origin allow-forms"
          className="size-full border-0"
        />
        {state === "playing" ? null : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted px-6 text-center text-sm text-muted-foreground">
            {state === "connecting" ? (
              <>
                <Spinner />
                Opening {site}…
              </>
            ) : (
              <>
                The sign-in browser didn't load.
                <Button size="sm" variant="outline" onClick={reload}>
                  Reload
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LockIcon aria-hidden className="size-3" />
        {site} in a cloud browser
      </p>
    </div>
  );
}
