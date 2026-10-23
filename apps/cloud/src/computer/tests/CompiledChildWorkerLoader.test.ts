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
  readonly lost = vi.fn();
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
  const load = vi.fn<WorkerLoader["load"]>();
  const registry = new Map([[hash, module]]);
  const port = createCompiledChildWorkerLoader({ get, load }, registry, { cpuMs });
  const target = new Target();
  return { port, target, get, load, getEntrypoint, run, registry, code: () => code };
}

function invocation(
  cpuMs = 300_000,
  loaderId = "slot-1",
): ChildWorkerInvocation & { readonly loaderId: string } {
  return {
    loaderId,
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
  it("uses the supplied loader ID verbatim", async () => {
    const f = fixture();

    await f.port.run(invocation(300_000, "slot-owner:17"), f.target);

    expect(f.get).toHaveBeenCalledWith("slot-owner:17", expect.any(Function));
  });

  it("keeps concurrent compiled calls under their own slot IDs", async () => {
    const f = fixture();

    await Promise.all([
      f.port.run(invocation(300_000, "compiled-slot-a"), new Target()),
      f.port.run(invocation(300_000, "compiled-slot-b"), new Target()),
    ]);

    expect(f.get.mock.calls.map(([id]) => id)).toEqual(["compiled-slot-a", "compiled-slot-b"]);
  });

  it("uses each acquired slot ID across command changes and loader ports", async () => {
    const f = fixture();
    await f.port.run(invocation(300_000, "slot-first"), f.target);
    await f.port.run(
      {
        ...invocation(300_000, "slot-second"),
        command: { ...command, argv: ["different"], env: { SECRET: "second" } },
      },
      new Target(),
    );
    const next = createCompiledChildWorkerLoader(
      { get: f.get, load: f.load },
      new Map([[hash, new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))]]),
    );
    await next.run(invocation(300_000, "slot-third"), new Target());
    const keys = f.get.mock.calls.map(([key]) => key);
    expect(keys).toEqual(["slot-first", "slot-second", "slot-third"]);
    await f.port.run(
      {
        ...invocation(300_000, "slot-fourth"),
        modules: { ...invocation().modules, "main.js": "export class Child { changed=true }" },
      },
      f.target,
    );
    expect(f.get.mock.calls.at(-1)?.[0]).toBe("slot-fourth");
    expect(f.load).not.toHaveBeenCalled();
  });

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

  it("rejects missing or empty loader IDs before loading and acknowledges no child", async () => {
    const { loaderId: _loaderId, ...missingId } = invocation();
    const inputs = [invocation(300_000, ""), missingId as ChildWorkerInvocation];

    for (const input of inputs) {
      const f = fixture();
      await expect(f.port.run(input, f.target)).rejects.toThrow(
        "Child loader ID must be a nonempty string",
      );

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

  it("retires the lost slot before acknowledging memory failure and never calls load", async () => {
    const events: string[] = [];
    const failedRun = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Worker failed"), { outcome: "exceededMemory" }));
    const recoveryRun = vi.fn(async (_command: unknown, target: { stopped(): void }) => {
      target.stopped();
      return exit;
    });
    const stub = (run: typeof failedRun | typeof recoveryRun) =>
      ({
        getEntrypoint: vi.fn().mockReturnValue({ run }),
        getDurableObjectClass: vi.fn(),
      }) as unknown as WorkerStub;
    const get = vi
      .fn<WorkerLoader["get"]>()
      .mockImplementation((loaderId) =>
        loaderId === "slot-lost" ? stub(failedRun) : stub(recoveryRun),
      );
    const load = vi.fn<WorkerLoader["load"]>();
    const loader = { get, load };
    const port = () => createCompiledChildWorkerLoader(loader, new Map([[hash, module]]));
    const lostTarget = new Target();
    lostTarget.lost.mockImplementation(async () => {
      events.push("lost");
    });
    lostTarget.stopped.mockImplementation(() => {
      events.push("stopped");
    });

    await expect(port().run(invocation(300_000, "slot-lost"), lostTarget)).resolves.toEqual({
      exitCode: 0,
      signal: 9,
      coreDumped: false,
    });
    await expect(port().run(invocation(300_000, "slot-fresh"), new Target())).resolves.toEqual(
      exit,
    );

    expect(failedRun).toHaveBeenCalledOnce();
    expect(get.mock.calls.map(([id]) => id)).toEqual(["slot-lost", "slot-fresh"]);
    expect(load).not.toHaveBeenCalled();
    expect(lostTarget.lost).toHaveBeenCalledOnce();
    expect(events).toEqual(["lost", "stopped"]);
    expect(recoveryRun).toHaveBeenCalledOnce();
  });

  it("fails closed when memory loss cannot retire the loader ID", async () => {
    const f = fixture();
    f.run.mockRejectedValue(new Error("Worker exceeded memory limit"));
    const target = new Target();
    target.lost.mockRejectedValue(new Error("slot retirement failed"));

    await expect(f.port.run(invocation(), target)).rejects.toThrow("slot retirement failed");

    expect(target.lost).toHaveBeenCalledOnce();
    expect(target.stopped).not.toHaveBeenCalled();
  });

  it("does not acknowledge memory loss when the target has no retirement RPC", async () => {
    const f = fixture();
    f.run.mockRejectedValue(new Error("Worker exceeded memory limit"));
    const target = { stopped: vi.fn() };

    await expect(f.port.run(invocation(), target as unknown as RpcTarget)).rejects.toThrow(
      "Child memory loss requires a loader retirement callback",
    );

    expect(f.get).toHaveBeenCalledOnce();
    expect(target.stopped).not.toHaveBeenCalled();
  });
});
