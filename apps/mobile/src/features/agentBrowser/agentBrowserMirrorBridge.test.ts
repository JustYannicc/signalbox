import { describe, expect, it } from "vite-plus/test";

import {
  agentBrowserMirrorPageUrl,
  agentBrowserMirrorScript,
  isAgentBrowserMirrorPage,
} from "./agentBrowserMirrorBridge";

const LS = String.fromCharCode(0x2028);

describe("agentBrowserMirrorScript", () => {
  it("hands every message to the page's receiver, in order", () => {
    const received: unknown[] = [];
    const script = agentBrowserMirrorScript([
      { type: "reset" },
      { type: "events", events: `[{"type":2,"text":"a${LS}b"}]` },
    ]);
    expect(script).not.toBeNull();
    expect(script).not.toContain(LS);
    const window = {
      __agentBrowserMirror: { receive: (message: unknown) => received.push(message) },
    };
    new Function("window", script!)(window);
    expect(received).toEqual([
      { type: "reset" },
      { type: "events", events: `[{"type":2,"text":"a${LS}b"}]` },
    ]);
  });

  it("does nothing before the page is ready, and has nothing to send for no messages", () => {
    expect(() =>
      new Function("window", agentBrowserMirrorScript([{ type: "reset" }])!)({}),
    ).not.toThrow();
    expect(agentBrowserMirrorScript([])).toBeNull();
  });
});

describe("agentBrowserMirrorPageUrl", () => {
  it("serves the page from the environment's origin", () => {
    expect(agentBrowserMirrorPageUrl("https://cloud.example.com/env/abc/")).toBe(
      "https://cloud.example.com/agent-browser.html",
    );
    expect(agentBrowserMirrorPageUrl(null)).toBeNull();
    expect(agentBrowserMirrorPageUrl("not a url")).toBeNull();
  });

  it("keeps the WebView on the mirror page", () => {
    const page = "https://cloud.example.com/agent-browser.html";
    expect(isAgentBrowserMirrorPage(`${page}#x`, page)).toBe(true);
    expect(isAgentBrowserMirrorPage("https://cloud.example.com/", page)).toBe(false);
    expect(isAgentBrowserMirrorPage("https://evil.example/agent-browser.html", page)).toBe(false);
  });

  it("follows the host's redirect to the page's extensionless path", () => {
    const page = "https://cloud.example.com/agent-browser.html";
    expect(isAgentBrowserMirrorPage("https://cloud.example.com/agent-browser", page)).toBe(true);
    expect(isAgentBrowserMirrorPage("https://cloud.example.com/agent-browser-x", page)).toBe(false);
    expect(isAgentBrowserMirrorPage("https://evil.example/agent-browser", page)).toBe(false);
  });
});
