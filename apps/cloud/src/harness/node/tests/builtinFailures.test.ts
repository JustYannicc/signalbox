import { describe, expect, it } from "vite-plus/test";
import {
  createHarnessNodeBuiltinInventory,
  inspectNodeBuiltinFunctionCapabilities,
} from "../../NodeBuiltinInventory.ts";
import { DEFAULT_NODE_NATIVE_MODULES } from "../nativeModules.ts";
import { createWorkerdNodeBuiltinFailures } from "../nativeBuiltinFailures.ts";
import { fixture } from "./fixture.ts";

// The distinct paths from the retained Claude 2.1.312 unsupported/missing-site report.
const paths = [
  ["fs", "statfsSync"],
  ["fs/promises", "statfs"],
  ["http2", "connect"],
  ["os", "getPriority"],
  ["os", "setPriority"],
  ["perf_hooks", "monitorEventLoopDelay"],
  ["tls", "createSecureContext"],
  ["tls", "setDefaultCACertificates"],
  ["util", "getSystemErrorName"],
  ["v8", "getHeapSpaceStatistics"],
  ["v8", "getHeapStatistics"],
  ["vm", "Script"],
  ["vm", "SourceTextModule"],
  ["vm", "SyntheticModule"],
  ["vm", "createContext"],
  ["vm", "runInContext"],
  ["vm", "runInThisContext"],
  ["process", "_getActiveHandles"],
  ["process", "_getActiveRequests"],
  ["process", "channel", "unref"],
  ["process", "send"],
] as const;

describe("unimplemented public Node calls", () => {
  it("throws or rejects with the advertised named code for every retained API gap", async () => {
    const f = fixture();
    const inventory = createHarnessNodeBuiltinInventory(
      {
        ...f.input,
        nativeModules: {
          ...createWorkerdNodeBuiltinFailures(DEFAULT_NODE_NATIVE_MODULES),
          ...f.input.nativeModules,
        },
      },
      new AbortController().signal,
    );
    try {
      for (const [specifier, ...memberPath] of paths) {
        const [capability] = inspectNodeBuiltinFunctionCapabilities(inventory.modules, [
          { specifier, memberPath },
        ]);
        expect(capability?.status, `${specifier}.${memberPath.join(".")}`).toBe("unsupported");
        expect(capability?.failure?.kind).toBe("named-error");
        expect(capability?.failure?.code).toBeTruthy();
        let receiver: object = inventory.modules[specifier]!;
        for (const part of memberPath.slice(0, -1)) receiver = Reflect.get(receiver, part);
        const callable: unknown = Reflect.get(receiver, memberPath.at(-1)!);
        expect(typeof callable).toBe("function");
        let caught: unknown;
        try {
          if (typeof callable !== "function") throw new TypeError("Expected a callable");
          if (specifier === "vm" && /Module|Script/.test(memberPath[0])) {
            Reflect.construct(callable, [""]);
          } else {
            await Reflect.apply(callable, receiver, specifier.startsWith("fs") ? ["/"] : []);
          }
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught).toMatchObject({ code: capability?.failure?.code });
      }
    } finally {
      await inventory.dispose();
      await f.close();
    }
  });

  it("preserves other native functions and selected host implementations", async () => {
    const f = fixture();
    const getHeapStatistics = () => ({ used_heap_size: 123 });
    const inventory = createHarnessNodeBuiltinInventory(
      { ...f.input, nativeModules: { ...f.input.nativeModules, v8: { getHeapStatistics } } },
      new AbortController().signal,
    );
    try {
      const modules = createWorkerdNodeBuiltinFailures(DEFAULT_NODE_NATIVE_MODULES);
      expect(Reflect.get(modules.tls!, "connect")).toBe(
        Reflect.get(DEFAULT_NODE_NATIVE_MODULES.tls!, "connect"),
      );
      expect(Reflect.get(inventory.modules.v8!, "getHeapStatistics")).toBe(getHeapStatistics);
      expect(getHeapStatistics()).toEqual({ used_heap_size: 123 });
      const result = inspectNodeBuiltinFunctionCapabilities(inventory.modules, [
        { specifier: "v8", memberPath: ["getHeapStatistics"] },
        { specifier: "v8", memberPath: ["unrecognized"] },
      ]);
      expect(result.map(({ status }) => status)).toEqual(["unknown", "missing"]);
      expect(result.every(({ failure }) => failure === undefined)).toBe(true);
    } finally {
      await inventory.dispose();
      await f.close();
    }
  });
});
