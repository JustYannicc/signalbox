import { RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { createCompiledChildWorkerLoader } from "../CompiledChildWorkerLoader.ts";
import type { ChildWorkerInvocation } from "../ChildWorkerProgram.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const hash = "a".repeat(64);
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const command = { executable: "/bin/tool", argv: ["tool"], cwd: "/work", env: {} };
const exit = { exitCode: 0, signal: 0, coreDumped: false };

class Target extends RpcTarget {
  readonly stopped = vi.fn();
}

class RawCaller extends RpcTarget {}

function fixture(cpuMs = 300_000) {
  const run = vi.fn().mockResolvedValue(exit);
  const getEntrypoint = vi.fn().mockReturnValue({ run });
  let code: WorkerLoaderWorkerCode | undefined;
  const get = vi.fn<WorkerLoader["get"]>().mockImplementation((_name, factory) => {
    const value = factory();
    if (value instanceof Promise) throw new Error("Unexpected async code factory");
    code = value;
    return { getEntrypoint, getDurableObjectClass: vi.fn() };
  });
  const registry = new Map([[hash, module]]);
  const port = createCompiledChildWorkerLoader({ get, load: vi.fn() }, registry, { cpuMs });
  const target = new Target();
  return { port, target, get, getEntrypoint, run, registry, code: () => code };
}

function invocation(cpuMs = 300_000): ChildWorkerInvocation {
  return {
    mainModule: "main.js",
    entrypoint: "Child",
    modules: {
      "main.js": "export class Child {}",
      "program.wasm": { wasmReference: hash },
    },
    limits: { cpuMs },
    command,
  };
}

describe("compiled child worker loader", () => {
  it.each([1_000, 300_000, 600_000])(
    "resolves static module identity at the loader with budget %s",
    async (cpuMs) => {
      const f = fixture(cpuMs);
      f.registry.delete(hash);
      await expect(f.port.run(invocation(cpuMs), f.target)).resolves.toEqual(exit);
      const code = f.code();
      expect(code?.modules["program.wasm"]).toHaveProperty("wasm", module);
      const wasm = code?.modules["program.wasm"];
      if (typeof wasm !== "object" || wasm === null) throw new Error("Missing compiled module");
      expect(wasm.wasm).toBe(module);
      expect(code?.limits).toEqual({ cpuMs });
      expect(f.getEntrypoint).toHaveBeenCalledWith("Child", { limits: code?.limits });
      expect(f.getEntrypoint.mock.calls[0]?.[1].limits).toBe(code?.limits);
      expect(f.run).toHaveBeenCalledWith(command, f.target);
      expect(f.target.stopped).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "unknown reference",
      { "main.js": "export default {}", "program.wasm": { wasmReference: "b".repeat(64) } },
    ],
    [
      "malformed reference",
      { "main.js": "export default {}", "program.wasm": { wasmReference: "unknown" } },
    ],
    [
      "invalid WASM bytes",
      { "main.js": "export default {}", "program.wasm": { wasm: new Uint8Array(8) } },
    ],
    ["invalid source", JSON.parse('{"main.js":{"js":1}}')],
  ])("rejects %s before loading and acknowledges that no child started", async (_name, modules) => {
    const f = fixture();
    const input = { ...invocation(), modules };
    await expect(f.port.run(input, f.target)).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.target.stopped).toHaveBeenCalledOnce();
  });

  it("preserves a legacy ArrayBuffer by identity through the same loader", async () => {
    const f = fixture();
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
    const target = new RawCaller();
    await expect(
      f.port.run(
        {
          ...invocation(),
          modules: { "main.js": "export class Child {}", "program.wasm": { wasm: bytes } },
        },
        target,
      ),
    ).resolves.toEqual(exit);
    const wasm = f.code()?.modules["program.wasm"];
    if (typeof wasm !== "object" || wasm === null) throw new Error("Missing WASM bytes");
    expect(wasm.wasm).toBe(bytes);
    expect(f.run).toHaveBeenCalledWith(command, target);
    expect(f.getEntrypoint).toHaveBeenCalledWith("Child", { limits: f.code()?.limits });
  });

  it("honors a declared SHA reference even when the payload also contains raw bytes", async () => {
    const f = fixture();
    const bytes = new ArrayBuffer(8);
    const input = (wasmReference: string) => ({
      ...invocation(),
      modules: {
        "main.js": "export class Child {}",
        "program.wasm": { wasmReference, wasm: bytes },
      },
    });
    await expect(f.port.run(input("b".repeat(64)), f.target)).rejects.toThrow(
      "Unknown child WASM reference",
    );
    await expect(f.port.run(input("invalid"), f.target)).rejects.toThrow(
      "Invalid child WASM reference",
    );
    expect(f.get).not.toHaveBeenCalled();
    expect(f.target.stopped).toHaveBeenCalledTimes(2);
    await expect(f.port.run(input(hash), f.target)).resolves.toEqual(exit);
    const wasm = f.code()?.modules["program.wasm"];
    if (typeof wasm !== "object" || wasm === null) throw new Error("Missing compiled WASM");
    expect(wasm.wasm).toBe(module);
    expect(wasm.wasm).not.toBe(bytes);
  });

  it("rejects mismatched CPU budgets and invalid entrypoints before loading", async () => {
    for (const input of [
      invocation(600_000),
      { ...invocation(), mainModule: "absent.js" },
      { ...invocation(), entrypoint: "bad/name" },
    ]) {
      const f = fixture();
      await expect(f.port.run(input, f.target)).rejects.toThrow();
      expect(f.get).not.toHaveBeenCalled();
      expect(f.target.stopped).toHaveBeenCalledOnce();
    }
  });

  it("does not acknowledge a failed dispatch after handing code to the loader", async () => {
    const f = fixture();
    const failure = new Error("RPC disconnected");
    f.run.mockRejectedValue(failure);
    await expect(f.port.run(invocation(), f.target)).rejects.toBe(failure);
    expect(f.get).toHaveBeenCalledOnce();
    expect(f.target.stopped).not.toHaveBeenCalled();
  });
});
