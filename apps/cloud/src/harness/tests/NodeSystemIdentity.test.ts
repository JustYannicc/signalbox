import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SYSTEM_IDENTITY,
  systemIdentityForThread,
} from "@t3tools/contracts/systemIdentity";
import { createNodeBridge } from "../../isolate/NodeBridge.ts";
import { createHarnessNodeBuiltinInventory } from "../NodeBuiltinInventory.ts";
import { fixture } from "../node/tests/fixture.ts";

describe("harness system identity", () => {
  it("installs the same configured machine identity in os and process", async () => {
    const f = fixture();
    const identity = systemIdentityForThread(f.input.computer.threadId, {
      release: "6.12.8-production",
      version: "#1 SMP PREEMPT_DYNAMIC",
      machine: "aarch64",
      hostnamePolicy: "thread",
      verification: "measured",
    });
    const inventory = createHarnessNodeBuiltinInventory(
      { ...f.input, systemIdentity: identity },
      new AbortController().signal,
    );
    try {
      const bridge = createNodeBridge(inventory.modules);
      const os = bridge.require("node:os");
      const process = bridge.require("node:process");
      for (const name of [
        "release",
        "version",
        "machine",
        "hostname",
        "platform",
        "arch",
        "type",
        "endianness",
      ] as const) {
        expect(Reflect.apply(Reflect.get(os, name), os, [])).toBe(identity[name]);
      }
      expect(Reflect.get(process, "platform")).toBe("linux");
      expect(Reflect.get(process, "arch")).toBe("arm64");
      expect(Reflect.get(process, "version")).toBe(f.input.identity.version);
    } finally {
      await inventory.dispose();
      await f.close();
    }
  });

  it("uses the shared provisional image default and a stable thread hostname", async () => {
    const f = fixture();
    const inventory = createHarnessNodeBuiltinInventory(f.input, new AbortController().signal);
    try {
      const bridge = createNodeBridge(inventory.modules);
      const os = bridge.require("os");
      expect(Reflect.apply(Reflect.get(os, "release"), os, [])).toBe(
        DEFAULT_SYSTEM_IDENTITY.release,
      );
      expect(Reflect.apply(Reflect.get(os, "hostname"), os, [])).toBe("t-test-thread");
      expect(Reflect.get(bridge.require("process"), "arch")).toBe("x64");
    } finally {
      await inventory.dispose();
      await f.close();
    }
  });
});
