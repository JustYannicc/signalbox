import { DATA_KIND, RUNNER_STREAM_BASE } from "@signalbox/runner-protocol/PreviewTunnel";
import type { AgentBrowserStep } from "@t3tools/contracts/signalboxPreviews";

import { sendData, type TunnelFrame } from "./previewProxy.ts";
import type { BrowserMirror, MirrorViewer } from "./RunnerBrowserMirror.ts";

/**
 * The agent's browser over the PreviewGateway's tunnel (#587): a viewer's
 * mirror as newline-delimited `AgentBrowserUpdate` JSON in body frames, and
 * each finished trail step as `trail.step`, its recording, then `end`.
 */

/** One viewer's mirror on `stream`, until the thread cancels it or the browser closes. */
export const serveMirror = (
  mirror: BrowserMirror,
  open: { readonly stream: number; readonly tabId: string | null },
  emit: (frame: TunnelFrame) => void,
  done: () => void,
): MirrorViewer => {
  let ended = false;
  const viewer = mirror.watch({
    viewerId: String(open.stream),
    tabId: open.tabId,
    send: (line) => {
      if (!ended) sendData(emit, open.stream, DATA_KIND.body, line);
    },
    end: () => {
      if (ended) return;
      ended = true;
      emit({ type: "end", stream: open.stream });
      done();
    },
  });
  return {
    input: viewer.input,
    close: () => {
      ended = true;
      viewer.close();
    },
  };
};

/** Numbers the streams of the Runner's own `trail.step`s, from `RUNNER_STREAM_BASE` up. */
export const makeTrailSender = () => {
  let next = RUNNER_STREAM_BASE;
  return (emit: (frame: TunnelFrame) => void, step: AgentBrowserStep, events: Uint8Array) => {
    const stream = next;
    next = next === 0xffff_ffff ? RUNNER_STREAM_BASE : next + 1;
    emit({ type: "trail.step", stream, step });
    sendData(emit, stream, DATA_KIND.body, events);
    emit({ type: "end", stream });
  };
};
