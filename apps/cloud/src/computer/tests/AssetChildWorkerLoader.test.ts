import { RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { createAssetChildWorkerLoader } from "../CompiledChildWorkerLoader.ts";
import type { ChildWorkerInvocation } from "../ChildWorkerCode.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const command = { executable: "/bin/tool", argv: ["tool"], cwd: "/work", env: {} };
const exit = { exitCode: 0, signal: 0, coreDumped: false };
const bytes = new TextEncoder().encode("the pinned wasm module").buffer as ArrayBuffer;

async function sha256(value: ArrayBuffer) {
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", value))]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

class Target extends RpcTarget {
  readonly stopped = vi.fn();
}

function invocation(wasmReference: string, loaderId = "asset-slot"): ChildWorkerInvocation {
  return {
    loaderId,
    mainModule: "main.js",
    entrypoint: "Child",
    modules: {
      "main.js": "export class Child {}",
      "requested.wasm": { wasmReference },
    },
    command,
  };
}

describe("asset child worker loader", () => {
  it("resolves only the requested reference inside the loader code callback", async () => {
    const hash = await sha256(bytes);
    const events: string[] = [];
    const resolveAsset = vi.fn(async (requested: string) => {
      events.push(`resolve:${requested}`);
      return requested === hash ? bytes : undefined;
    });
    let materialized: WorkerLoaderWorkerCode | undefined;
    const entrypoint = {
      [Symbol.dispose]: vi.fn(() => events.push("entrypoint-disposed")),
      run: vi.fn(async () => exit),
    };
    const worker = {
      [Symbol.dispose]: vi.fn(() => events.push("worker-disposed")),
      getEntrypoint: vi.fn(() => entrypoint),
      getDurableObjectClass: vi.fn(),
    };
    const loader: WorkerLoader = {
      get: vi.fn<WorkerLoader["get"]>().mockImplementation((_name, code) => {
        events.push("loader-get");
        void Promise.resolve(code()).then(
          (loaded) => (materialized = loaded),
          () => undefined,
        );
        return {
          ...worker,
          getEntrypoint: worker.getEntrypoint,
        } as unknown as WorkerStub;
      }),
      load: vi.fn(),
    };
    const target = new Target();
    const port = createAssetChildWorkerLoader(loader, resolveAsset);

    await expect(port.run(invocation(hash), target)).resolves.toEqual(exit);

    expect(resolveAsset).toHaveBeenCalledExactlyOnceWith(hash);
    expect(materialized?.modules["requested.wasm"]).toEqual({ wasm: bytes });
    expect(events).toEqual([
      "loader-get",
      `resolve:${hash}`,
      "entrypoint-disposed",
      "worker-disposed",
    ]);
    expect(target.stopped).not.toHaveBeenCalled();
  });

  it("does not resolve the code callback again for a cached loader ID", async () => {
    const hash = await sha256(bytes);
    const resolveAsset = vi.fn(async () => bytes);
    const workers = new Map<string, WorkerStub>();
    const get = vi.fn<WorkerLoader["get"]>().mockImplementation((name, code) => {
      let worker = workers.get(name);
      if (worker === undefined) {
        worker = {
          getEntrypoint: vi.fn(() => ({ run: vi.fn(async () => exit) })),
          getDurableObjectClass: vi.fn(),
        } as unknown as WorkerStub;
        workers.set(name, worker);
        void Promise.resolve(code()).catch(() => undefined);
      }
      return worker;
    });
    const port = createAssetChildWorkerLoader({ get, load: vi.fn() }, resolveAsset);

    await expect(port.run(invocation(hash), new Target())).resolves.toEqual(exit);
    await expect(port.run(invocation(hash), new Target())).resolves.toEqual(exit);

    expect(get).toHaveBeenCalledTimes(2);
    expect(resolveAsset).toHaveBeenCalledExactlyOnceWith(hash);
  });

  it("rejects mismatched bytes before code is returned and acknowledges after stub disposal", async () => {
    const expectedHash = await sha256(bytes);
    const wrongBytes = new TextEncoder().encode("different bytes").buffer as ArrayBuffer;
    const events: string[] = [];
    const resolveAsset = vi.fn(async () => {
      events.push("asset-resolver");
      await Promise.resolve();
      return wrongBytes;
    });
    const entrypointRun = vi.fn();
    const entrypoint = {
      [Symbol.dispose]: vi.fn(() => events.push("entrypoint-disposed")),
      run: entrypointRun,
    };
    const worker = {
      [Symbol.dispose]: vi.fn(() => events.push("worker-disposed")),
      getEntrypoint: vi.fn((_name: string | undefined, _options?: unknown) => {
        events.push("entrypoint-acquired");
        return entrypoint;
      }),
      getDurableObjectClass: vi.fn(),
    };
    const get = vi.fn<WorkerLoader["get"]>().mockImplementation((_name, _code) => {
      events.push("loader-get");
      void Promise.resolve(_code()).catch(() => undefined);
      return worker as unknown as WorkerStub;
    });
    const target = new Target();
    target.stopped.mockImplementation(() => events.push("stopped"));
    const port = createAssetChildWorkerLoader({ get, load: vi.fn() }, resolveAsset);

    await expect(port.run(invocation(expectedHash), target)).rejects.toThrow(
      "Child WASM asset hash mismatch",
    );

    expect(resolveAsset).toHaveBeenCalledOnce();
    expect(entrypointRun).not.toHaveBeenCalled();
    expect(events).toEqual([
      "loader-get",
      "entrypoint-acquired",
      "asset-resolver",
      "entrypoint-disposed",
      "worker-disposed",
      "stopped",
    ]);
    expect(target.stopped).toHaveBeenCalledOnce();
  });

  it("acknowledges a missing asset only after retiring the loader stub", async () => {
    const hash = await sha256(bytes);
    const events: string[] = [];
    const entrypoint = {
      [Symbol.dispose]: vi.fn(() => events.push("entrypoint-disposed")),
      run: vi.fn(),
    };
    const worker = {
      [Symbol.dispose]: vi.fn(() => events.push("worker-disposed")),
      getEntrypoint: vi.fn((_name: string | undefined, _options?: unknown) => entrypoint),
      getDurableObjectClass: vi.fn(),
    };
    const get = vi.fn<WorkerLoader["get"]>().mockImplementation((_name, code) => {
      void Promise.resolve(code()).catch(() => undefined);
      return worker as unknown as WorkerStub;
    });
    const target = new Target();
    target.stopped.mockImplementation(() => events.push("stopped"));
    const resolveAsset = vi.fn(async () => undefined);
    const port = createAssetChildWorkerLoader({ get, load: vi.fn() }, resolveAsset);

    await expect(port.run(invocation(hash), target)).rejects.toThrow("Unknown child WASM asset");

    expect(resolveAsset).toHaveBeenCalledExactlyOnceWith(hash);
    expect(events).toEqual(["entrypoint-disposed", "worker-disposed", "stopped"]);
    expect(target.stopped).toHaveBeenCalledOnce();
  });
});
