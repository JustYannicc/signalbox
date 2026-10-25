import { describe, expect, it } from "@effect/vitest";
import { inspectNodeBuiltinFunctionCapabilities } from "../../harness/NodeBuiltinInventory.ts";
import { getNodeBuiltinCapability } from "../NodeBuiltinCapabilities.ts";
import { createNodeFs } from "../NodeFs.ts";
import { nodeFsPosixFixture } from "./helpers/NodeFsPosixFixture.ts";

describe("Node fs callable capabilities", () => {
  it("resolves realpathSync.native through the canonical guest resolver", () => {
    const test = nodeFsPosixFixture();
    const modules = createNodeFs(test.kernelFs);
    try {
      const fs = modules.fs;
      fs.writeFileSync("/target", "guest bytes");
      fs.symlinkSync("/target", "/alias");

      expect(fs.realpathSync.native).toBe(fs.realpathSync);
      expect(fs.realpathSync.native("/alias")).toBe("/target");
      expect(() => fs.realpathSync.native("/missing")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      const hostOnlyPath = decodeURIComponent(new URL(import.meta.url).pathname);
      expect(() => fs.realpathSync.native(hostOnlyPath)).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      test.close();
    }
  });

  it("declares exported functions without invoking accessors and keeps shared aliases identical", () => {
    const test = nodeFsPosixFixture();
    const modules = createNodeFs(test.kernelFs);
    let getterCalls = 0;
    try {
      expect(modules.fs.promises).toBe(modules["fs/promises"]);
      expect(modules.fs.realpath.native).toBe(modules.fs.realpath);
      expect(modules.fs.realpathSync.native).toBe(modules.fs.realpathSync);

      const inspectableFs = Object.create(
        null,
        Object.getOwnPropertyDescriptors(modules.fs),
      ) as object;
      Object.defineProperty(inspectableFs, "inventoryTrap", {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error("inventory must not invoke getters");
        },
      });

      const requests = [
        { specifier: "node:fs", memberPath: ["writeFileSync"] },
        { specifier: "fs", memberPath: ["promises", "readFile"] },
        { specifier: "fs/promises", memberPath: ["readFile"] },
        { specifier: "fs", memberPath: ["statfsSync"] },
        { specifier: "fs/promises", memberPath: ["statfs"] },
        { specifier: "fs", memberPath: ["chmodSync"] },
        { specifier: "fs/promises", memberPath: ["chmod"] },
        { specifier: "fs", memberPath: ["realpathSync", "native"] },
        { specifier: "fs", memberPath: ["realpath", "native"] },
        { specifier: "fs", memberPath: ["inventoryTrap"] },
      ] as const;
      const capabilities = inspectNodeBuiltinFunctionCapabilities(
        { fs: inspectableFs, "fs/promises": modules["fs/promises"] },
        requests,
      );

      expect(capabilities.map(({ status }) => status)).toEqual([
        "supported",
        "supported",
        "supported",
        "unsupported",
        "unsupported",
        "supported",
        "supported",
        "supported",
        "supported",
        "unknown",
      ]);
      expect(capabilities[9]?.evidence).toContain("accessor that was not invoked");
      expect(getNodeBuiltinCapability(modules.fs.realpathSync.native)).toMatchObject({
        status: "supported",
      });
      const unmarkedExports = [modules.fs, modules["fs/promises"]].flatMap((module) =>
        Object.getOwnPropertyNames(module).flatMap((name) => {
          const descriptor = Object.getOwnPropertyDescriptor(module, name);
          return descriptor &&
            "value" in descriptor &&
            typeof descriptor.value === "function" &&
            getNodeBuiltinCapability(descriptor.value) === undefined
            ? [name]
            : [];
        }),
      );
      expect(unmarkedExports).toEqual([]);
      expect(getterCalls).toBe(0);
    } finally {
      test.close();
    }
  });

  it("marks POSIX methods conditional only when the kernel has no POSIX policy", () => {
    const posix = nodeFsPosixFixture();
    const plain = nodeFsPosixFixture(false);
    const posixModules = createNodeFs(posix.kernelFs);
    const plainModules = createNodeFs(plain.kernelFs);
    const requests = [
      { specifier: "fs", memberPath: ["accessSync"] },
      { specifier: "fs", memberPath: ["chmodSync"] },
      { specifier: "fs", memberPath: ["fchownSync"] },
      { specifier: "fs/promises", memberPath: ["access"] },
      { specifier: "fs/promises", memberPath: ["chmod"] },
    ] as const;
    try {
      const posixCapabilities = inspectNodeBuiltinFunctionCapabilities(
        { fs: posixModules.fs, "fs/promises": posixModules["fs/promises"] },
        requests,
      );
      const plainCapabilities = inspectNodeBuiltinFunctionCapabilities(
        { fs: plainModules.fs, "fs/promises": plainModules["fs/promises"] },
        requests,
      );

      expect(posixCapabilities.map(({ status }) => status)).toEqual([
        "supported",
        "supported",
        "supported",
        "supported",
        "supported",
      ]);
      expect(plainCapabilities.map(({ status }) => status)).toEqual([
        "conditional",
        "conditional",
        "conditional",
        "conditional",
        "conditional",
      ]);
      expect(plainCapabilities[1]?.evidence).toContain("POSIX policy");
    } finally {
      posix.close();
      plain.close();
    }
  });
});
