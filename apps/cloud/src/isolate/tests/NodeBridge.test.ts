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
