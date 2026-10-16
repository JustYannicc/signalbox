import type { AgentBrowserDrivingInput } from "@t3tools/contracts/signalboxPreviews";
import { describe, expect, it } from "vite-plus/test";

import {
  createAgentBrowserInputSender,
  parseAgentBrowserMirrorPageMessage,
} from "./signalboxAgentBrowserMirror.ts";

describe("parseAgentBrowserMirrorPageMessage", () => {
  const click = {
    _tag: "mouse",
    action: "down",
    x: 10,
    y: 20,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: 0,
  };

  it("reads messages from postMessage data and WebView JSON alike", () => {
    expect(parseAgentBrowserMirrorPageMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(
      parseAgentBrowserMirrorPageMessage(JSON.stringify({ type: "input", input: click })),
    ).toEqual({ type: "input", input: click });
    expect(
      parseAgentBrowserMirrorPageMessage({ type: "viewport", width: 1280, height: 720 }),
    ).toEqual({ type: "viewport", width: 1280, height: 720 });
  });

  it("refuses anything else, including taking control from inside the page", () => {
    expect(parseAgentBrowserMirrorPageMessage("{")).toBeNull();
    expect(parseAgentBrowserMirrorPageMessage({ type: "events" })).toBeNull();
    expect(
      parseAgentBrowserMirrorPageMessage({ type: "input", input: { _tag: "take" } }),
    ).toBeNull();
    expect(
      parseAgentBrowserMirrorPageMessage({ type: "input", input: { ...click, x: "10" } }),
    ).toBeNull();
    expect(
      parseAgentBrowserMirrorPageMessage({ type: "viewport", width: 0, height: 1 }),
    ).toBeNull();
  });
});

describe("createAgentBrowserInputSender", () => {
  const mouse = (action: "move" | "down" | "up", x: number): AgentBrowserDrivingInput => ({
    _tag: "mouse",
    action,
    x,
    y: 0,
    button: action === "move" ? "none" : "left",
    buttons: action === "down" ? 1 : 0,
    clickCount: action === "move" ? 0 : 1,
    modifiers: 0,
  });

  const start = () => {
    const sent: AgentBrowserDrivingInput[] = [];
    const landings: Array<() => void> = [];
    const sender = createAgentBrowserInputSender((input) => {
      sent.push(input);
      return new Promise<void>((resolve) => landings.push(resolve));
    });
    const land = async () => {
      landings.shift()?.();
      // Let the landed promise's handlers run.
      await Promise.resolve();
      await Promise.resolve();
    };
    return { sender, sent, land };
  };

  it("keeps one move in flight and sends only the newest after it lands", async () => {
    const { sender, sent, land } = start();
    sender(mouse("move", 1));
    sender(mouse("move", 2));
    sender(mouse("move", 3));
    expect(sent).toEqual([mouse("move", 1)]);
    await land();
    expect(sent).toEqual([mouse("move", 1), mouse("move", 3)]);
    await land();
    expect(sent).toHaveLength(2);
  });

  it("never drops or reorders presses, and sends a waiting move before them", () => {
    const { sender, sent } = start();
    sender(mouse("move", 1));
    sender(mouse("move", 2));
    sender(mouse("down", 2));
    sender(mouse("up", 2));
    sender({ _tag: "text", text: "hi" });
    expect(sent).toEqual([
      mouse("move", 1),
      mouse("move", 2),
      mouse("down", 2),
      mouse("up", 2),
      { _tag: "text", text: "hi" },
    ]);
  });

  it("keeps going after a failed send", async () => {
    const sent: AgentBrowserDrivingInput[] = [];
    const sender = createAgentBrowserInputSender((input) => {
      sent.push(input);
      return Promise.reject(new Error("gone"));
    });
    sender(mouse("move", 1));
    sender(mouse("move", 2));
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([mouse("move", 1), mouse("move", 2)]);
  });
});
