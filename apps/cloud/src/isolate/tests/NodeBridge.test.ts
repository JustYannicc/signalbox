import * as NodeDiagnosticsChannel from "node:diagnostics_channel";
import { describe, expect, it } from "@effect/vitest";
import { createNodeBridge, installNodeBridge } from "../NodeBridge.ts";

describe("Node builtin routing", () => {
  it("bare and node aliases retain the supplied module identity", () => {
    const promises = { readFile: () => "bytes" };
    const fs = { promises };
    const bridge = createNodeBridge({ fs, "node:fs": fs });
    expect(bridge.require("node:fs")).toBe(fs);
    expect(bridge.require("fs")).toBe(fs);
    expect(bridge.require("node:fs/promises")).toBe(promises);
    expect(bridge.names).toEqual(["fs", "fs/promises"]);
    expect(() => createNodeBridge({ fs, "fs/promises": {} })).toThrow(
      expect.objectContaining({ code: "NODE_BRIDGE_ALIAS_CONFLICT" }),
    );
    expect(() => createNodeBridge({ fs: {}, "fs/promises": promises })).toThrow(
      expect.objectContaining({ code: "NODE_BRIDGE_ALIAS_CONFLICT" }),
    );
  });

  it("diagnostics channels retain native identity through both bridge aliases", () => {
    const bridge = createNodeBridge({ "node:diagnostics_channel": NodeDiagnosticsChannel });
    expect(bridge.require("diagnostics_channel")).toBe(NodeDiagnosticsChannel);
    expect(bridge.require("node:diagnostics_channel")).toBe(NodeDiagnosticsChannel);
    const channel = NodeDiagnosticsChannel.channel(Symbol("bridge-channel"));
    const payload = { value: 42 };
    const received: unknown[] = [];
    const subscriber = (message: unknown) => received.push(message);
    channel.subscribe(subscriber);
    try {
      channel.publish(payload);
      expect(received).toEqual([payload]);
      expect(received[0]).toBe(payload);
    } finally {
      channel.unsubscribe(subscriber);
    }
    expect(channel.hasSubscribers).toBe(false);
    expect(() => createNodeBridge({}).require("node:diagnostics_channel")).toThrow(
      expect.objectContaining({ code: "NODE_BUILTIN_UNAVAILABLE" }),
    );
  });

  it("missing and conflicting modules fail instead of reaching a native VFS", () => {
    expect(() => createNodeBridge({ fs: {}, "node:fs": {} })).toThrow(
      expect.objectContaining({ code: "NODE_BRIDGE_ALIAS_CONFLICT" }),
    );
    const bridge = createNodeBridge({ fs: {} });
    expect(() => bridge.require("fs/promises")).toThrow(
      expect.objectContaining({ code: "NODE_BUILTIN_UNAVAILABLE" }),
    );
    expect(() => bridge.require("node:unreviewed")).toThrow(
      expect.objectContaining({ code: "NODE_BUILTIN_UNKNOWN" }),
    );
  });

  it("another host cannot overwrite a Worker bridge", () => {
    const first = createNodeBridge({ fs: {} });
    const second = createNodeBridge({ fs: {} });
    const installed = installNodeBridge(first);
    try {
      expect(() => installNodeBridge(second)).toThrow(
        expect.objectContaining({ code: "NODE_BRIDGE_ALREADY_INSTALLED" }),
      );
    } finally {
      installed.restore();
    }
    installed.restore();
    const next = installNodeBridge(second);
    next.restore();
  });
});
