/**
 * The agent browser mirror page (`/agent-browser.html`), shared by the web,
 * desktop and mobile clients. It replays the agent's tab from rrweb events into
 * a frame that runs no scripts, scaled to fit, and while the host makes it
 * interactive it turns the person's input into the agent browser's input.
 * While only following, a click on a link asks the host for your own copy of
 * it (#597); the agent's tab never moves.
 * The bridge messages are `AgentBrowserMirrorHostMessage` and
 * `AgentBrowserMirrorPageMessage` in client-runtime.
 */
import "@rrweb/replay/dist/style.css";
import "./mirror.css";

import { Replayer } from "@rrweb/replay";
import { EventType, type eventWithTime } from "@rrweb/types";
import type { AgentBrowserDrivingInput } from "@t3tools/contracts/signalboxPreviews";
import type {
  AgentBrowserMirrorHostMessage,
  AgentBrowserMirrorPageMessage,
} from "@t3tools/client-runtime/state/signalboxAgentBrowserMirror";

import { sampledCanvasPlugin } from "./canvas";
import { fitPage, fractionIn, toPagePoint, type Fit, type Size } from "./geometry";
import { attachInput } from "./input";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
    __agentBrowserMirror?: { receive: (message: unknown) => void };
  }
}

const ACTIVITY_EVERY_MS = 30_000;
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

const stage = document.getElementById("stage")!;
const surface = document.getElementById("surface")!;
const keyboard = document.getElementById("keyboard") as HTMLTextAreaElement;
const hostOrigin = location.origin === "null" ? "*" : location.origin;

let replayer: Replayer | null = null;
let page: Size | null = null;
let fit: Fit = { scale: 1, left: 0, top: 0 };
let interactive = false;
let copyLinks = false;
let lastActivityAt = Number.NEGATIVE_INFINITY;

function post(message: AgentBrowserMirrorPageMessage) {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- React Native's bridge takes only the message.
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  else if (window.parent !== window) window.parent.postMessage(message, hostOrigin);
}

function layout() {
  fit = page
    ? fitPage({ width: window.innerWidth, height: window.innerHeight }, page)
    : { scale: 1, left: 0, top: 0 };
  const transform = `translate(${fit.left}px, ${fit.top}px) scale(${fit.scale})`;
  for (const wrapper of stage.children) (wrapper as HTMLElement).style.transform = transform;
}

function onViewport(size: unknown) {
  const { width, height } = (size ?? {}) as Partial<Size>;
  if (typeof width !== "number" || typeof height !== "number" || !(width > 0 && height > 0)) return;
  if (page?.width === width && page.height === height) return;
  page = { width, height };
  layout();
  post({ type: "viewport", width, height });
}

function destroy(target: Replayer) {
  try {
    target.destroy();
  } catch {
    // Already taken out of the stage by a reset.
  }
}

function reset() {
  if (replayer) destroy(replayer);
  stage.replaceChildren();
  replayer = null;
}

/** Starts over from a full snapshot. The old page stays up until the new one is built. */
function rebuild(events: ReadonlyArray<eventWithTime>) {
  const previous = replayer;
  const next = new Replayer([], {
    root: stage,
    liveMode: true,
    // Changes land in the real DOM as they arrive; there's no timeline to fast-forward.
    useVirtualDom: false,
    mouseTail: false,
    triggerFocus: false,
    showWarning: false,
    // Stops the mirrored page's CSS animations: the mirror never repaints on its own.
    pauseAnimation: true,
    plugins: [sampledCanvasPlugin()],
  });
  replayer = next;
  next.on("resize", onViewport);
  if (previous) {
    let replaced = false;
    next.on("fullsnapshot-rebuilded", () => {
      if (replaced) return;
      replaced = true;
      destroy(previous);
    });
  }
  // A baseline past every timestamp applies each event the moment it arrives.
  next.startLive(Number.MAX_SAFE_INTEGER);
  layout();
  for (const event of events) next.addEvent(event);
}

function parseEvents(json: string): ReadonlyArray<eventWithTime> {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as eventWithTime[]) : [];
  } catch {
    return [];
  }
}

function receive(raw: unknown) {
  let message: unknown = raw;
  if (typeof raw === "string") {
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
  }
  if (typeof message !== "object" || message === null || !("type" in message)) return;
  const typed = message as AgentBrowserMirrorHostMessage;
  switch (typed.type) {
    case "events": {
      if (typeof typed.events !== "string") return;
      const events = parseEvents(typed.events);
      const first = events[0];
      if (!first) return;
      if (first.type === EventType.Meta || first.type === EventType.FullSnapshot) rebuild(events);
      else if (replayer) for (const event of events) replayer.addEvent(event);
      return;
    }
    case "interactive":
      interactive = typed.on === true;
      document.body.classList.toggle("interactive", interactive);
      keyboard.disabled = !interactive;
      if (!interactive) keyboard.blur();
      surface.style.cursor = "";
      return;
    case "copyLinks":
      copyLinks = typed.on === true;
      document.body.classList.toggle("copy-links", copyLinks);
      if (!copyLinks) surface.style.cursor = "";
      return;
    case "reset":
      reset();
      return;
  }
}

/**
 * The innermost replayed element at a point in the page's CSS pixels, with
 * the point in that element's own frame: nested frames are entered, not
 * stopped at.
 */
function elementAt(x: number, y: number): { element: Element; x: number; y: number } | null {
  let document = replayer?.iframe.contentDocument ?? null;
  let at = { x, y };
  for (let depth = 0; document !== null && depth < 8; depth += 1) {
    const element = document.elementFromPoint(at.x, at.y);
    if (!element) return null;
    const inner = element.nodeName === "IFRAME" ? (element as HTMLIFrameElement) : null;
    const innerDocument = inner?.contentDocument ?? null;
    if (inner === null || innerDocument === null) return { element, ...at };
    const box = inner.getBoundingClientRect();
    at = { x: at.x - box.left - inner.clientLeft, y: at.y - box.top - inner.clientTop };
    document = innerDocument;
  }
  return null;
}

/** Elements that span the page: a spot across them says less than the point itself. */
const PAGE_ELEMENTS = new Set(["HTML", "BODY"]);

/**
 * Adds the element under a pointer input to it: the machine aims at that
 * element's box in the agent's page, which the viewer's fonts may lay out
 * differently from this replay. Moves are already coalesced to one per
 * frame by now, so this looks up once per sent input, not per pointer event.
 */
function anchored(input: AgentBrowserDrivingInput): AgentBrowserDrivingInput {
  if (input._tag !== "mouse" && input._tag !== "wheel") return input;
  const hit = elementAt(input.x, input.y);
  if (hit === null || replayer === null || PAGE_ELEMENTS.has(hit.element.nodeName)) return input;
  const node = replayer.getMirror().getId(hit.element);
  if (node < 0) return input;
  const at = fractionIn(hit.element.getBoundingClientRect(), hit.x, hit.y);
  return { ...input, target: { node, ...at } };
}

function isEditableAt(x: number, y: number): boolean {
  const element = elementAt(x, y)?.element;
  if (!element) return false;
  if (element.nodeName === "TEXTAREA" || element.nodeName === "SELECT") return true;
  if (element.nodeName === "INPUT")
    return !NON_TEXT_INPUTS.has((element.getAttribute("type") ?? "text").toLowerCase());
  return (element as HTMLElement).isContentEditable === true;
}

/** The web address of the link under a point of the frame, or null. */
function linkAt(clientX: number, clientY: number): string | null {
  if (page === null) return null;
  const point = toPagePoint(clientX, clientY, fit, page, false);
  if (point === null) return null;
  // rrweb records links as absolute addresses, so the replay's own base doesn't matter.
  const href = elementAt(point.x, point.y)?.element.closest("a[href]")?.getAttribute("href");
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

let hoverFrame: number | null = null;
let hoverAt: { x: number; y: number } | null = null;

/** Points at links while following, looked up once per frame at most. */
function onFollowHover(event: PointerEvent) {
  if (interactive || !copyLinks || event.pointerType !== "mouse") return;
  hoverAt = { x: event.clientX, y: event.clientY };
  hoverFrame ??= requestAnimationFrame(() => {
    hoverFrame = null;
    const at = hoverAt;
    // Driving may have started since the move.
    const following = !interactive && copyLinks && at !== null;
    surface.style.cursor = following && linkAt(at.x, at.y) !== null ? "pointer" : "";
  });
}

function onFollowClick(event: MouseEvent) {
  // A double click is one copy, not two.
  if (interactive || !copyLinks || event.detail > 1) return;
  const url = linkAt(event.clientX, event.clientY);
  if (url !== null) post({ type: "copy", url });
}

function noteActivity() {
  const now = Date.now();
  if (now - lastActivityAt < ACTIVITY_EVERY_MS) return;
  lastActivityAt = now;
  post({ type: "activity" });
}

attachInput({
  surface,
  keyboard,
  enabled: () => interactive && page !== null,
  toPage: (clientX, clientY, clamp) =>
    page ? toPagePoint(clientX, clientY, fit, page, clamp) : null,
  scale: () => fit.scale,
  pageHeight: () => page?.height ?? 0,
  isEditableAt,
  send: (input) => post({ type: "input", input: anchored(input) }),
});

for (const type of ["pointerdown", "pointermove", "keydown", "wheel"] as const) {
  document.addEventListener(type, noteActivity, { passive: true, capture: true });
}
surface.addEventListener("pointermove", onFollowHover, { passive: true });
surface.addEventListener("click", onFollowClick);
window.addEventListener("resize", layout);
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== location.origin) return;
  receive(event.data);
});
window.__agentBrowserMirror = { receive };
post({ type: "ready" });
