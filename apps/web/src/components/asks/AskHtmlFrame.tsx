import {
  ASK_HTML_SANDBOX,
  askHtmlShellDocument,
  readAskHtmlShellMessage,
} from "@t3tools/client-runtime/askHtml";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";

const MIN_HEIGHT = 80;

/**
 * Agent HTML two frames deep: an opaque-origin shell Signalbox owns, whose policy blocks every
 * navigation of the view inside it, and the view itself. Each mount gets its own nonce and
 * secret and the round remounts it, so an older round's view never reaches the draft.
 */
export function AskHtmlFrame(props: {
  readonly html: string;
  readonly title: string;
  readonly maxHeight: number;
  /** Absent for previews, which can't answer. */
  readonly onAnswer?: (value: unknown) => void;
}) {
  const [ids] = useState(() => ({ nonce: randomUUID(), secret: randomUUID() }));
  const shell = useRef<HTMLIFrameElement>(null);
  const [navigated, setNavigated] = useState(false);
  const [height, setHeight] = useState(MIN_HEIGHT * 2);
  const srcDoc = askHtmlShellDocument(props.html, ids, "parent");
  const { maxHeight, onAnswer } = props;

  useEffect(() => {
    if (navigated) return;
    const listener = (event: MessageEvent) => {
      // The view can post to this page directly; only what the shell sealed counts.
      if (shell.current === null || event.source !== shell.current.contentWindow) return;
      const message = readAskHtmlShellMessage(event.data, ids);
      if (message?.type === "navigated") setNavigated(true);
      else if (message?.type === "height") {
        setHeight(Math.max(MIN_HEIGHT, Math.min(message.height, maxHeight)));
      } else if (message?.type === "answer") onAnswer?.(message.value);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [ids, navigated, maxHeight, onAnswer]);

  if (navigated) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        {props.title} left its page, so it was stopped. Its earlier answer, if any, is kept.
      </p>
    );
  }
  return (
    <iframe
      ref={shell}
      title={props.title}
      sandbox={ASK_HTML_SANDBOX}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      className="block w-full rounded-md border border-border bg-background"
      style={{ height }}
    />
  );
}
