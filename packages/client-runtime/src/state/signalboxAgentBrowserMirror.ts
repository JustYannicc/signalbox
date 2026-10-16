import { AgentBrowserDrivingInput } from "@t3tools/contracts/signalboxPreviews";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { reportableUrl } from "../browsing/browsingRecord.ts";

/**
 * The mirror page (`/agent-browser.html`) and its host talk in these messages.
 * In an iframe both sides use `postMessage`; in a React Native WebView the
 * page posts JSON through `window.ReactNativeWebView.postMessage` and the host
 * calls `window.__agentBrowserMirror.receive(message)`.
 */
export type AgentBrowserMirrorHostMessage =
  /** rrweb events as a JSON array; one starting with a full snapshot replaces the page. */
  | { readonly type: "events"; readonly events: string }
  /** Whether the page sends the person's input. */
  | { readonly type: "interactive"; readonly on: boolean }
  /** Whether clicking a link while not driving asks for your own copy of it (#597). */
  | { readonly type: "copyLinks"; readonly on: boolean }
  /** Show nothing. */
  | { readonly type: "reset" };

export type AgentBrowserMirrorPageMessage =
  /** Loaded; send everything again from the start. */
  | { readonly type: "ready" }
  /** Only while interactive, in the page's CSS pixels. */
  | { readonly type: "input"; readonly input: AgentBrowserDrivingInput }
  /** The person touched the mirror (throttled). */
  | { readonly type: "activity" }
  /** The mirrored page's viewport, when it changes. */
  | { readonly type: "viewport"; readonly width: number; readonly height: number }
  /** The person clicked a link while following: open it in a tab of their own. */
  | { readonly type: "copy"; readonly url: string };

// Only driving input: taking or handing back control is the host's call, never the page's.
const decodeDrivingInput = Schema.decodeUnknownOption(AgentBrowserDrivingInput);

/** A page message from `postMessage` data or a WebView's JSON string; null if it isn't one. */
export function parseAgentBrowserMirrorPageMessage(
  data: unknown,
): AgentBrowserMirrorPageMessage | null {
  let message: unknown = data;
  if (typeof data === "string") {
    try {
      message = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof message !== "object" || message === null || !("type" in message)) return null;
  switch (message.type) {
    case "ready":
      return { type: "ready" };
    case "activity":
      return { type: "activity" };
    case "viewport":
      return "width" in message &&
        "height" in message &&
        typeof message.width === "number" &&
        typeof message.height === "number" &&
        message.width > 0 &&
        message.height > 0
        ? { type: "viewport", width: message.width, height: message.height }
        : null;
    case "copy": {
      // Only web pages: a mirrored page's link is the agent's site's to choose.
      const url =
        "url" in message && typeof message.url === "string" ? reportableUrl(message.url) : null;
      return url === null ? null : { type: "copy", url };
    }
    case "input": {
      if (!("input" in message)) return null;
      const input = Option.getOrNull(decodeDrivingInput(message.input));
      return input === null ? null : { type: "input", input };
    }
    default:
      return null;
  }
}

type AgentBrowserMouseMove = Extract<
  AgentBrowserDrivingInput,
  { readonly _tag: "mouse"; readonly action: "move" }
>;

const isMouseMove = (input: AgentBrowserDrivingInput): input is AgentBrowserMouseMove =>
  input._tag === "mouse" && input.action === "move";

/**
 * Sends the page's input in order without letting pointer moves pile up
 * behind a slow connection: while a move is in flight, newer moves collapse
 * to the newest, which goes out once it lands. Every other input is sent as
 * it comes, never dropped, after any move still waiting.
 */
export function createAgentBrowserInputSender(
  send: (input: AgentBrowserDrivingInput) => Promise<unknown>,
): (input: AgentBrowserDrivingInput) => void {
  let movesInFlight = 0;
  let waitingMove: AgentBrowserMouseMove | null = null;
  const sendMove = (move: AgentBrowserMouseMove) => {
    movesInFlight += 1;
    const landed = () => {
      movesInFlight -= 1;
      if (movesInFlight > 0 || waitingMove === null) return;
      const next = waitingMove;
      waitingMove = null;
      sendMove(next);
    };
    void send(move).then(landed, landed);
  };
  return (input) => {
    if (isMouseMove(input)) {
      if (movesInFlight > 0) waitingMove = input;
      else sendMove(input);
      return;
    }
    // The page saw that move before this input, so the machine must too.
    if (waitingMove !== null) {
      const move = waitingMove;
      waitingMove = null;
      sendMove(move);
    }
    void send(input).catch(() => undefined);
  };
}
