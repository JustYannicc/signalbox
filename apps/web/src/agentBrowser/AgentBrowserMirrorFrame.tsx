import {
  AGENT_BROWSER_MIRROR_NOTHING_DELIVERED,
  planAgentBrowserMirrorDelivery,
  type AgentBrowserMirrorContent,
} from "@t3tools/client-runtime/state/signalboxAgentBrowserFrame";
import {
  parseAgentBrowserMirrorPageMessage,
  type AgentBrowserMirrorHostMessage,
} from "@t3tools/client-runtime/state/signalboxAgentBrowserMirror";
import type { AgentBrowserDrivingInput } from "@t3tools/contracts/signalboxPreviews";
import { useEffect, useRef } from "react";

const MIRROR_PAGE_URL = `${import.meta.env.BASE_URL}agent-browser.html`;
const HOST_ORIGIN = window.location.origin === "null" ? "*" : window.location.origin;

/**
 * The shared mirror page in a frame. Sends it the page's events as they
 * arrive, each batch once, and everything again whenever the page (re)loads.
 */
export function AgentBrowserMirrorFrame(props: {
  readonly content: AgentBrowserMirrorContent;
  readonly interactive: boolean;
  readonly onInput: (input: AgentBrowserDrivingInput) => void;
  readonly onActivity: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const deliveredRef = useRef(AGENT_BROWSER_MIRROR_NOTHING_DELIVERED);
  const latestRef = useRef(props);

  const deliverRef = useRef(() => {
    const target = frameRef.current?.contentWindow;
    if (!target || !readyRef.current) return;
    const plan = planAgentBrowserMirrorDelivery(latestRef.current.content, deliveredRef.current);
    deliveredRef.current = plan.delivered;
    for (const message of plan.messages) target.postMessage(message, HOST_ORIGIN);
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      const message = parseAgentBrowserMirrorPageMessage(event.data);
      if (message === null) return;
      switch (message.type) {
        case "ready":
          readyRef.current = true;
          deliveredRef.current = AGENT_BROWSER_MIRROR_NOTHING_DELIVERED;
          frameRef.current?.contentWindow?.postMessage(
            { type: "interactive", on: latestRef.current.interactive },
            HOST_ORIGIN,
          );
          deliverRef.current();
          return;
        case "input":
          if (latestRef.current.interactive) latestRef.current.onInput(message.input);
          return;
        case "activity":
          latestRef.current.onActivity();
          return;
        case "viewport":
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Every render: new batches go out once each, and the handlers see the latest props.
  useEffect(() => {
    latestRef.current = props;
    deliverRef.current();
  });

  useEffect(() => {
    if (!readyRef.current) return;
    const message: AgentBrowserMirrorHostMessage = { type: "interactive", on: props.interactive };
    frameRef.current?.contentWindow?.postMessage(message, HOST_ORIGIN);
  }, [props.interactive]);

  return (
    // oxlint-disable-next-line react/iframe-missing-sandbox -- the mirror page is ours and needs scripts and its origin (module scripts load without CORS); the mirrored page runs in rrweb's script-free frame inside it.
    <iframe
      ref={frameRef}
      src={MIRROR_PAGE_URL}
      title="Agent's browser"
      className="absolute inset-0 size-full border-0"
    />
  );
}
