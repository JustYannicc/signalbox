/**
 * The custom HTML view an ask question can carry (#669). Agent HTML runs in an opaque-origin
 * sandbox frame and reaches the host only through `window.signalbox.answer(value)`; an answer
 * only updates the draft, and Send commits it.
 *
 * What this guarantees: the view runs outside the app's origin, so it can't read the app's
 * cookies, storage, session or other threads, and its only channel to the host is the answer.
 * Its loads are constrained, not its every network path: CSP doesn't govern WebRTC or DNS
 * prefetching, so this is not full network isolation.
 *
 * Two documents, on web and React Native alike:
 * - the view: the agent's markup under the bridge script, behind a policy that loads only inline
 *   script and style and data: images, fonts and media, with no fetches, frames, workers or
 *   form posts;
 * - the shell, which Signalbox owns and which embeds the view. Its `frame-src 'none'` stops the
 *   view navigating: a browser checks every navigation of a frame against the policy of the
 *   document embedding it, so the view can load its initial `srcdoc` (not a fetch) but can't
 *   navigate itself, or be refreshed, to any URL.
 *
 * The shell relays only messages whose source is its own frame, sealed with a secret the view
 * can't read: the shell's script is in another opaque origin. The host accepts only sealed
 * envelopes from the shell frame, and only view messages carrying this mount's nonce.
 */
import { decodeAskKitAnswer } from "@t3tools/shared/askKitAnswer";
import * as Result from "effect/Result";

export const ASK_HTML_SANDBOX = "allow-scripts";
export const ASK_HTML_ANSWER_MAX_LENGTH = 64_000;
export const ASK_HTML_MAX_HEIGHT = 2_000;

const CHANNEL = "signalbox-ask";

// What the view may use: inline script and style, and data: images, fonts and media.
export const ASK_HTML_VIEW_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// The shell runs only its own inline script and embeds only the view's srcdoc.
export const ASK_HTML_SHELL_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "frame-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const scriptString = (value: string) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const attribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function bridge(nonce: string) {
  return `(function(){var nonce=${scriptString(nonce)};
var post=function(m){m.channel=${scriptString(CHANNEL)};m.nonce=nonce;parent.postMessage(m,"*");};
Object.defineProperty(window,"signalbox",{value:Object.freeze({answer:function(value){post({type:"answer",value:value});}})});
var report=function(){post({type:"height",height:Math.ceil(document.documentElement.scrollHeight)});};
addEventListener("load",report);
if(typeof ResizeObserver==="function")new ResizeObserver(report).observe(document.documentElement);})();`;
}

/** The view. Policy and bridge come first, so the agent's markup runs after both. */
export function askHtmlDocument(html: string, nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${ASK_HTML_VIEW_POLICY}">
<meta http-equiv="x-dns-prefetch-control" content="off">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0}body{font:14px/1.5 system-ui,sans-serif}</style>
<script>${bridge(nonce)}</script></head><body>${html}</body></html>`;
}

/**
 * Where the shell hands its sealed envelopes. On web it posts to the embedding page; React
 * Native exposes `ReactNativeWebView` to every frame on Android, which is why every envelope
 * carries the secret rather than trusting the channel.
 */
export type AskHtmlRelay = "parent" | "native";

function relayScript(relay: AskHtmlRelay, secret: string) {
  const seal = `{secret:${scriptString(secret)},envelope:m}`;
  return relay === "parent"
    ? `function(m){try{parent.postMessage(${seal},"*");}catch(e){}}`
    : `function(m){try{window.ReactNativeWebView.postMessage(JSON.stringify(${seal}));}catch(e){}}`;
}

/**
 * The shell around the view. The view is its `srcdoc` from the first parse, so its first load
 * is the view itself; a later load means it navigated despite the policy, and the shell stops.
 */
export function askHtmlShellDocument(
  html: string,
  ids: { readonly nonce: string; readonly secret: string },
  relay: AskHtmlRelay,
): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${ASK_HTML_SHELL_POLICY}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;background:transparent}iframe{border:0;display:block;width:100%;height:100vh}</style></head>
<body><iframe id="ask" sandbox="${ASK_HTML_SANDBOX}" title="Custom answer view" srcdoc="${attribute(askHtmlDocument(html, ids.nonce))}"></iframe>
<script>(function(){var frame=document.getElementById("ask"),send=${relayScript(relay, ids.secret)},channel=${scriptString(CHANNEL)},loads=0,live=true;
frame.addEventListener("load",function(){loads+=1;if(loads>1&&live){live=false;send({channel:channel,kind:"navigated"});}});
window.addEventListener("message",function(e){if(live&&e.source===frame.contentWindow)send({channel:channel,kind:"relay",message:e.data});});})();</script></body></html>`;
}

/**
 * Only the shell and its view ever load in a React Native ask WebView, so any other URL is a
 * navigation the view tried and the WebView refuses it, on top of the shell's policy.
 */
export function isAskHtmlNavigationAllowed(url: string): boolean {
  return url === "about:blank" || url === "about:srcdoc";
}

export type AskHtmlMessage =
  | { readonly type: "answer"; readonly value: unknown }
  | { readonly type: "height"; readonly height: number }
  | { readonly type: "navigated" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const htmlSurface = { options: [], surface: { kind: "html", html: "" } } as const;

/** A JSON copy of what the view posted; undefined when it isn't JSON or is too large. */
function answerValue(value: unknown): unknown {
  if (Result.isFailure(decodeAskKitAnswer(htmlSurface, { value }))) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > ASK_HTML_ANSWER_MAX_LENGTH) return undefined;
  return JSON.parse(serialized) as unknown;
}

/** One message from the view opened with `nonce`; anything else is null. */
function readViewMessage(data: unknown, nonce: string): AskHtmlMessage | null {
  if (!isRecord(data) || data.channel !== CHANNEL || data.nonce !== nonce) return null;
  if (data.type === "height") {
    const { height } = data;
    return typeof height === "number" && Number.isFinite(height) && height >= 0
      ? { type: "height", height: Math.min(height, ASK_HTML_MAX_HEIGHT) }
      : null;
  }
  if (data.type !== "answer" || !("value" in data)) return null;
  const value = answerValue(data.value);
  return value === undefined ? null : { type: "answer", value };
}

/**
 * Reads one sealed envelope from the shell. The view's own messages only ever arrive inside a
 * relay, so a view can't claim the shell's navigation stop. On web, callers first check that the
 * message came from the shell frame. A null result must leave the draft untouched.
 */
export function readAskHtmlShellMessage(
  sealed: unknown,
  ids: { readonly nonce: string; readonly secret: string },
): AskHtmlMessage | null {
  if (!isRecord(sealed) || sealed.secret !== ids.secret) return null;
  const { envelope } = sealed;
  if (!isRecord(envelope) || envelope.channel !== CHANNEL) return null;
  if (envelope.kind === "navigated") return { type: "navigated" };
  return envelope.kind === "relay" ? readViewMessage(envelope.message, ids.nonce) : null;
}

/** Reads a React Native WebView message, which arrives as the shell's JSON string. */
export function readAskHtmlNativeMessage(
  raw: string,
  ids: { readonly nonce: string; readonly secret: string },
): AskHtmlMessage | null {
  if (raw.length > ASK_HTML_ANSWER_MAX_LENGTH * 2) return null;
  try {
    return readAskHtmlShellMessage(JSON.parse(raw), ids);
  } catch {
    return null;
  }
}
