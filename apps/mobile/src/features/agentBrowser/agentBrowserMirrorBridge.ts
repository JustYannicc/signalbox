import type { AgentBrowserMirrorHostMessage } from "@t3tools/client-runtime/state/signalboxAgentBrowserMirror";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * The script that hands messages to the page through `injectJavaScript`.
 * JSON is a JS literal except for U+2028/U+2029 in older engines; escape them.
 */
export function agentBrowserMirrorScript(
  messages: ReadonlyArray<AgentBrowserMirrorHostMessage>,
): string | null {
  if (messages.length === 0) return null;
  const literal = JSON.stringify(messages)
    .replaceAll(LINE_SEPARATOR, "\\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
  return `(function(){var m=window.__agentBrowserMirror;if(!m)return;var all=${literal};for(var i=0;i<all.length;i++)m.receive(all[i]);})();true;`;
}

/** The shared mirror page on the environment's own origin; null if the base URL isn't one. */
export function agentBrowserMirrorPageUrl(httpBaseUrl: string | null): string | null {
  if (httpBaseUrl === null) return null;
  try {
    return new URL("/agent-browser.html", httpBaseUrl).toString();
  } catch {
    return null;
  }
}

/** Whether a WebView navigation is the mirror page itself (the page never leaves it). */
export function isAgentBrowserMirrorPage(url: string, pageUrl: string): boolean {
  try {
    const target = new URL(url);
    const page = new URL(pageUrl);
    return target.origin === page.origin && target.pathname === page.pathname;
  } catch {
    return false;
  }
}
