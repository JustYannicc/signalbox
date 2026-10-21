import * as NodeProcess from "node:process";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as HarnessInventory from "../../src/harness/NodeBuiltinInventory.ts";
import * as NodeDns from "../../src/isolate/NodeDns.ts";
import type { NodeHarnessProcessInput } from "../../src/harness/NodeHarnessProcess.ts";
import { captureRuntimeBuiltinInventory } from "./runtimeBuiltinInventory.ts";

// Claude's supplied official source + SDK inventory. This is a requirement, never an installed list.
const officialRequiredBuiltins = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "crypto",
  "dns",
  "dns/promises",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "readline",
  "stream",
  "stream/consumers",
  "stream/promises",
  "string_decoder",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
];
const createInventory = HarnessInventory.createHarnessNodeBuiltinInventory;
const createDns = NodeDns.createNodeDns;

function assertClosed(input: NodeHarnessProcessInput) {
  expect(() => input.computer.files.cwd).toThrow();
  expect([...input.computer.files.descriptors.entries()]).toEqual([]);
  expect(() => input.stdio.assertBound(input.computer.files)).toThrow("disposed");
  expect(input.stdio.signal.aborted).toBe(true);
  expect(input.host.processes.size).toBe(0);
  const launch = vi.fn((): never => {
    throw new Error("Unexpected launch");
  });
  expect(input.host.processes.spawn(undefined, launch, () => {})).toMatchObject({
    status: "error",
    error: { code: "CANCELLED" },
  });
  expect(launch).not.toHaveBeenCalled();
  expect(input.host.wakes.size).toBe(0);
  expect(input.host.wakes.register(() => () => {})).toMatchObject({
    status: "error",
    error: { code: "CANCELLED" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("runtime builtin inventory", () => {
  it("captures production objects with defaults and contextual DNS without installing globals", async () => {
    const globals = Object.getOwnPropertyDescriptors(globalThis);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Unexpected network access");
    });
    let input: NodeHarnessProcessInput | undefined;
    let runtime: ReturnType<typeof createInventory> | undefined;
    vi.spyOn(HarnessInventory, "createHarnessNodeBuiltinInventory").mockImplementation(
      (value, signal) => {
        input = value;
        expect(signal.aborted).toBe(false);
        expect(value.nativeModules).toEqual({});
        expect(value.computer.files.cwd).toBe("/");
        runtime = createInventory(value, signal);
        return runtime;
      },
    );
    const modules = await captureRuntimeBuiltinInventory();
    expect(modules).toBe(runtime?.modules);
    expect(officialRequiredBuiltins).toHaveLength(37);
    for (const name of officialRequiredBuiltins) {
      expect(modules[name], name).toBeDefined();
      expect(modules[name], name).not.toBeNull();
      expect(["object", "function"], name).toContain(typeof modules[name]);
      expect(Object.keys(modules[name]!).length, name).toBeGreaterThan(0);
    }
    for (const name of ["dns", "dns/promises"]) {
      expect(Reflect.get(modules[name]!, "lookup")).toBeTypeOf("function");
      expect(Reflect.get(modules[name]!, "resolve4")).toBeTypeOf("function");
      expect(Reflect.get(modules[name]!, "Resolver")).toBeTypeOf("function");
    }
    expect(Reflect.get(modules.dns!, "promises")).toBe(modules["dns/promises"]);
    expect(Reflect.get(modules.fs!, "promises")).toBe(modules["fs/promises"]);
    expect(Reflect.get(modules.fs!, "readFileSync")).toBeTypeOf("function");
    expect(Reflect.get(modules["fs/promises"]!, "readFile")).toBeTypeOf("function");
    expect(Reflect.get(modules.crypto!, "createHash")).toBeTypeOf("function");
    expect(modules.process).not.toBe(NodeProcess);
    for (const name of ["stdin", "stdout", "stderr"]) {
      expect(Reflect.get(modules.process!, name)).toMatchObject({ destroyed: true, closed: true });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(input).toBeDefined();
    assertClosed(input!);
    for (const operation of [
      input!.computer.exec,
      input!.computer.port,
      input!.computer.save,
      input!.loadPackages,
      input!.loadRelease,
      input!.modelTransport,
    ]) {
      expect(() => Reflect.apply(operation, undefined, [])).toThrow("Builtin inventory must not");
    }
    fetch.mockRestore();
    expect(Object.getOwnPropertyDescriptors(globalThis)).toEqual(globals);
  });

  it("waits for DNS draining before returning the disposed inventory", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let returned = false;
    vi.spyOn(NodeDns, "createNodeDns").mockImplementation((options) => {
      const dns = createDns(options);
      return {
        ...dns,
        async drain() {
          await dns.drain();
          expect(options?.signal?.aborted).toBe(true);
          entered.resolve();
          await release.promise;
        },
      };
    });
    const capture = captureRuntimeBuiltinInventory().then((modules) => {
      returned = true;
      return modules;
    });
    try {
      await entered.promise;
      expect(returned).toBe(false);
    } finally {
      release.resolve();
      await capture;
    }
    expect(returned).toBe(true);
  });

  it("releases kernel resources when runtime construction fails", async () => {
    let input: NodeHarnessProcessInput | undefined;
    vi.spyOn(HarnessInventory, "createHarnessNodeBuiltinInventory").mockImplementation(
      (value, signal) => {
        input = value;
        return createInventory({ ...value, identity: { ...value.identity, version: "" } }, signal);
      },
    );
    await expect(captureRuntimeBuiltinInventory()).rejects.toThrow("non-empty version");
    expect(input).toBeDefined();
    assertClosed(input!);
  });

  it("still releases kernel resources if runtime disposal fails", async () => {
    let input: NodeHarnessProcessInput | undefined;
    vi.spyOn(HarnessInventory, "createHarnessNodeBuiltinInventory").mockImplementation(
      (value, signal) => {
        input = value;
        const runtime = createInventory(value, signal);
        return {
          ...runtime,
          async dispose() {
            await runtime.dispose();
            throw new Error("injected cleanup failure");
          },
        };
      },
    );
    await expect(captureRuntimeBuiltinInventory()).rejects.toThrow("injected cleanup failure");
    expect(input).toBeDefined();
    assertClosed(input!);
  });
});
