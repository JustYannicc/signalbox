import { describe, expect, it } from "vite-plus/test";

import {
  ASK_HTML_ANSWER_MAX_LENGTH,
  ASK_HTML_MAX_HEIGHT,
  ASK_HTML_SANDBOX,
  ASK_HTML_SHELL_POLICY,
  ASK_HTML_VIEW_POLICY,
  askHtmlDocument,
  askHtmlShellDocument,
  isAskHtmlNavigationAllowed,
  readAskHtmlNativeMessage,
  readAskHtmlShellMessage,
} from "@t3tools/client-runtime/askHtml";

const ids = { nonce: "round-2-frame", secret: "shell-secret" };
const view = (fields: Record<string, unknown>) => ({
  channel: "signalbox-ask",
  nonce: ids.nonce,
  ...fields,
});
const relayed = (message: unknown, secret = ids.secret) => ({
  secret,
  envelope: { channel: "signalbox-ask", kind: "relay", message },
});
const read = (message: unknown) => readAskHtmlShellMessage(relayed(message), ids);

describe("custom ask view messages", () => {
  it("accepts a view's answer only sealed by the shell, for this frame and round", () => {
    const answer = view({ type: "answer", value: { pick: "b" } });
    expect(read(answer)).toEqual({ type: "answer", value: { pick: "b" } });
    // The view posting straight to the host, unsealed, or sealed with a guess.
    expect(readAskHtmlShellMessage(answer, ids)).toBeNull();
    expect(readAskHtmlShellMessage(relayed(answer, "guess"), ids)).toBeNull();
    expect(read({ ...answer, nonce: "round-1-frame" })).toBeNull();
    expect(read({ ...answer, channel: "mcp" })).toBeNull();
    expect(read(view({ type: "answer" }))).toBeNull();
    expect(read(view({ type: "submit", value: 1 }))).toBeNull();
  });

  it("lets only the shell report navigation, never the view", () => {
    const stop = { secret: ids.secret, envelope: { channel: "signalbox-ask", kind: "navigated" } };
    expect(readAskHtmlShellMessage(stop, ids)).toEqual({ type: "navigated" });
    expect(read(view({ type: "navigated" }))).toBeNull();
    expect(read({ channel: "signalbox-ask", kind: "navigated" })).toBeNull();
  });

  it("drops answers that aren't plain bounded JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      Number.NaN,
      cyclic,
      new Uint8Array([1]),
      new Map([["a", 1]]),
      "x".repeat(ASK_HTML_ANSWER_MAX_LENGTH),
    ]) {
      expect(read(view({ type: "answer", value }))).toBeNull();
    }
  });

  it("hands the draft a copy, not the object the view posted", () => {
    const posted = { nested: { pick: "b" } };
    const message = read(view({ type: "answer", value: posted }));
    expect(message).toEqual({ type: "answer", value: posted });
    expect(message?.type === "answer" && message.value !== posted).toBe(true);
  });

  it("bounds the height a view may ask for", () => {
    expect(read(view({ type: "height", height: 240 }))).toEqual({ type: "height", height: 240 });
    expect(read(view({ type: "height", height: 1e9 }))).toEqual({
      type: "height",
      height: ASK_HTML_MAX_HEIGHT,
    });
    expect(read(view({ type: "height", height: -1 }))).toBeNull();
  });

  it("reads React Native's string messages the same way, and nothing malformed", () => {
    const sealed = relayed(view({ type: "answer", value: "b" }));
    expect(readAskHtmlNativeMessage(JSON.stringify(sealed), ids)).toEqual({
      type: "answer",
      value: "b",
    });
    expect(readAskHtmlNativeMessage("{not json", ids)).toBeNull();
    expect(readAskHtmlNativeMessage(JSON.stringify(relayed(view({}), "guess")), ids)).toBeNull();
    expect(
      readAskHtmlNativeMessage(" ".repeat(ASK_HTML_ANSWER_MAX_LENGTH * 2 + 1), ids),
    ).toBeNull();
  });
});

describe("custom ask view policy", () => {
  const hostile = '<p>Pick</p>"></iframe><script>parent.postMessage("forged","*")</script>';
  const srcdoc = (shell: string) =>
    /srcdoc="([^"]*)"/.exec(shell)?.[1]?.replace(/&quot;/g, '"') ?? "";

  it("lets the view script and show data images, and load nothing else", () => {
    for (const directive of [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "img-src data:",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
    ]) {
      expect(ASK_HTML_VIEW_POLICY).toContain(directive);
    }
    expect(ASK_HTML_VIEW_POLICY).not.toMatch(/https?:|'self'|\*/);
  });

  it("puts the policy and bridge before the agent's markup", () => {
    const html = askHtmlDocument(hostile, ids.nonce);
    const policy = html.indexOf(ASK_HTML_VIEW_POLICY);
    expect(policy).toBeGreaterThan(-1);
    expect(html.indexOf('window,"signalbox"')).toBeGreaterThan(policy);
    expect(html.indexOf(hostile)).toBeGreaterThan(html.indexOf("</head>"));
  });

  it("blocks every navigation of the view from the shell's own policy", () => {
    // A browser checks a frame's navigations against the policy of the document embedding it.
    expect(ASK_HTML_SHELL_POLICY).toContain("frame-src 'none'");
    expect(ASK_HTML_SHELL_POLICY).toContain("default-src 'none'");
    expect(ASK_HTML_SHELL_POLICY).not.toMatch(/https?:|'self'|\*|data:|blob:/);
    const shell = askHtmlShellDocument(hostile, ids, "parent");
    expect(shell).toContain(`content="${ASK_HTML_SHELL_POLICY}"`);
    expect(shell).toContain(`sandbox="${ASK_HTML_SANDBOX}"`);
    expect(ASK_HTML_SANDBOX).toBe("allow-scripts");
  });

  it("embeds the view as escaped srcdoc, so its markup can't reach the shell", () => {
    const shell = askHtmlShellDocument(hostile, ids, "parent");
    expect(shell.match(/<script>/g)).toHaveLength(1);
    expect(shell.match(/<iframe /g)).toHaveLength(1);
    expect(srcdoc(shell)).toContain("&lt;script&gt;parent.postMessage");
  });

  it("keeps the shell's secret out of the view's document", () => {
    for (const relay of ["parent", "native"] as const) {
      const shell = askHtmlShellDocument(hostile, ids, relay);
      expect(shell).toContain(ids.secret);
      expect(srcdoc(shell)).not.toContain(ids.secret);
      expect(srcdoc(shell)).toContain(ids.nonce);
    }
  });

  it("relays only its own frame's messages, to the host its platform has", () => {
    const web = askHtmlShellDocument("", ids, "parent");
    const native = askHtmlShellDocument("", ids, "native");
    expect(web).toContain("e.source===frame.contentWindow");
    expect(web).toContain("parent.postMessage(");
    expect(web).not.toContain("ReactNativeWebView");
    expect(native).toContain("window.ReactNativeWebView.postMessage(");
  });

  it("lets a React Native ask WebView load only the shell and its view", () => {
    expect(isAskHtmlNavigationAllowed("about:blank")).toBe(true);
    expect(isAskHtmlNavigationAllowed("about:srcdoc")).toBe(true);
    for (const url of [
      "https://example.invalid/?answer=1",
      "http://localhost:3000",
      "data:text/html,<p>",
      "blob:null/abc",
      "javascript:alert(1)",
      "about:blank#leak",
      "file:///etc/hosts",
    ]) {
      expect(isAskHtmlNavigationAllowed(url)).toBe(false);
    }
  });
});
