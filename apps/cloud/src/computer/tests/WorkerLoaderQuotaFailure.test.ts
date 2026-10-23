import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { WORKER_LOADER_QUOTA_MESSAGES } from "../ChildWorkerDispatchError.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createCompiledChildWorkerLoader } from "../CompiledChildWorkerLoader.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const exit = { exitCode: 0, signal: 0, coreDumped: false };
const quotaCases = [
  ["direct", WORKER_LOADER_QUOTA_MESSAGES[0]!],
  ["direct", WORKER_LOADER_QUOTA_MESSAGES[1]!],
  ["compiled", WORKER_LOADER_QUOTA_MESSAGES[0]!],
  ["compiled", WORKER_LOADER_QUOTA_MESSAGES[1]!],
  ["compiled-rpc", WORKER_LOADER_QUOTA_MESSAGES[0]!],
  ["compiled-rpc", WORKER_LOADER_QUOTA_MESSAGES[1]!],
] as const;

function throughWorkerLoaderRpcProxy(loader: ChildWorkerLoaderPort, events: string[]) {
  return {
    run(
      input: Parameters<ChildWorkerLoaderPort["run"]>[0],
      target: Parameters<ChildWorkerLoaderPort["run"]>[1],
    ) {
      const local = target as typeof target & { host(): object; stopped(): void };
      const host = local.host.bind(local);
      const stopped = local.stopped.bind(local);
      vi.spyOn(local, "host").mockImplementation(() => {
        events.push("host");
        return host();
      });
      vi.spyOn(local, "stopped").mockImplementation(() => {
        events.push("stopped");
        stopped();
      });
      // Model the service's distinct target identity while calls update the caller's marker.
      const remote = new Proxy(local, {
        get(origin, key) {
          const value = Reflect.get(origin, key, origin);
          return typeof value === "function" ? value.bind(origin) : value;
        },
      });
      return loader.run(input, remote);
    },
  } satisfies ChildWorkerLoaderPort;
}

async function withContext(run: (context: KernelAsyncProgramContext) => Promise<void>) {
  const fixture = createTestFilesystem();
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({ wakes });
  const identity = processes.spawn(
    undefined,
    () => ({
      completion: Promise.resolve(exit),
      signal: () => ({ status: "ok", value: undefined }),
    }),
    () => {},
  );
  if (identity.status !== "ok") throw new Error("Process admission failed");
  try {
    await run({
      filesystem: fixture.filesystem,
      home: undefined,
      args: ["tool"],
      env: {},
      identity: identity.value,
      signal: new AbortController().signal,
      processes,
      wakes,
      spawn: async () => {
        throw new Error("Unexpected nested spawn");
      },
      exec: async () => {
        throw new Error("Unexpected replacement exec");
      },
    });
  } finally {
    await processes.dispose();
    wakes.dispose();
    fixture.close();
  }
}

describe("Worker Loader quota failures", () => {
  it.each(quotaCases)(
    "releases capacity and lets its owner run again after the %s %s rejection",
    async (kind, message) =>
      withContext(async (context) => {
        let quotaPending = true;
        let codeFactoryCalls = 0;
        const events: string[] = [];
        const runEntrypoint = vi.fn(async (_command: unknown, target: unknown) => {
          (target as { host(): object }).host();
          (target as { stopped(): void }).stopped();
          return exit;
        });
        const entrypoint = {
          run: runEntrypoint,
          [Symbol.dispose]: vi.fn(),
        };
        const worker = {
          getEntrypoint: vi.fn(() => entrypoint),
          getDurableObjectClass: vi.fn(),
          [Symbol.dispose]: vi.fn(),
        };
        const get = vi.fn<WorkerLoader["get"]>().mockImplementation((_id, code) => {
          if (quotaPending) {
            quotaPending = false;
            throw new Error(message);
          }
          const workerCode = code();
          if (workerCode instanceof Promise) throw new Error("Unexpected async code factory");
          codeFactoryCalls++;
          return worker as unknown as WorkerStub;
        });
        const workerLoader = { get, load: vi.fn() };
        const compiledLoader = createCompiledChildWorkerLoader(
          workerLoader,
          new Map<string, WebAssembly.Module>(),
        );
        const loader =
          kind === "direct"
            ? workerLoader
            : kind === "compiled"
              ? compiledLoader
              : throughWorkerLoaderRpcProxy(compiledLoader, events);
        const dispatch = createWorkerLoaderDispatch<object>(loader);
        const capacity = new ChildWorkerCapacity(1, {
          owner: `test/worker-loader-quota-${kind}-${message.includes("10 concurrent") ? "10" : "4"}`,
        });
        const close = vi.fn();
        const program = createChildWorkerProgram({
          executable: "/bin/tool",
          code: { mainModule: "entry.js", modules: { "entry.js": "export default class {}" } },
          capacity,
          dispatch,
          createHost: () => ({ host: {}, close }),
        });

        await expect(program.run(context)).rejects.toMatchObject({
          message,
          code: "CHILD_EXECUTION_FAILED",
          cause: { message, code: "EAGAIN" },
          termination: { kind: "stopped" },
        });
        await program.drain();
        expect(capacity.active).toBe(0);
        expect(close).toHaveBeenCalledOnce();
        expect(worker.getEntrypoint).not.toHaveBeenCalled();
        expect(runEntrypoint).not.toHaveBeenCalled();
        expect(codeFactoryCalls).toBe(0);
        if (kind === "compiled-rpc") expect(events).toEqual(["stopped"]);

        const retry = createChildWorkerProgram({
          executable: "/bin/tool",
          code: { mainModule: "entry.js", modules: { "entry.js": "export default class {}" } },
          capacity,
          dispatch,
          createHost: () => ({ host: {}, close }),
        });
        await expect(retry.run(context)).resolves.toEqual(exit);
        await retry.drain();
        expect(capacity.active).toBe(0);
        expect(close).toHaveBeenCalledTimes(2);
        expect(worker.getEntrypoint).toHaveBeenCalledOnce();
        expect(runEntrypoint).toHaveBeenCalledOnce();
        expect(codeFactoryCalls).toBe(1);
        if (kind === "compiled-rpc") expect(events).toEqual(["stopped", "host", "stopped"]);
      }),
  );

  it.each(quotaCases)(
    "releases capacity and retries after the %s entrypoint run rejects with %s",
    async (kind, message) =>
      withContext(async (context) => {
        let quotaPending = true;
        let codeFactoryCalls = 0;
        let entrypointRuns = 0;
        let disposedWorkers = 0;
        let disposedEntrypoints = 0;
        const events: string[] = [];
        const get = vi.fn<WorkerLoader["get"]>().mockImplementation((_id, code) => {
          const workerCode = () => {
            codeFactoryCalls++;
            return code();
          };
          return {
            getEntrypoint: vi.fn(() => ({
              [Symbol.dispose]: vi.fn(() => {
                disposedEntrypoints++;
              }),
              async run(_command: unknown, target: unknown) {
                entrypointRuns++;
                if (quotaPending) {
                  quotaPending = false;
                  throw new Error(message);
                }
                const resolvedCode = workerCode();
                if (resolvedCode instanceof Promise)
                  throw new Error("Unexpected async code factory");
                (target as { host(): object }).host();
                (target as { stopped(): void }).stopped();
                return exit;
              },
            })),
            getDurableObjectClass: vi.fn(),
            [Symbol.dispose]: vi.fn(() => {
              disposedWorkers++;
            }),
          } as unknown as WorkerStub;
        });
        const workerLoader = { get, load: vi.fn() };
        const compiledLoader = createCompiledChildWorkerLoader(
          workerLoader,
          new Map<string, WebAssembly.Module>(),
        );
        const loader =
          kind === "direct"
            ? workerLoader
            : kind === "compiled"
              ? compiledLoader
              : throughWorkerLoaderRpcProxy(compiledLoader, events);
        const dispatch = createWorkerLoaderDispatch<object>(loader);
        const capacity = new ChildWorkerCapacity(1, {
          owner: `test/worker-loader-run-quota-${kind}-${message.includes("10 concurrent") ? "10" : "4"}`,
        });
        const close = vi.fn();
        const program = createChildWorkerProgram({
          executable: "/bin/tool",
          code: { mainModule: "entry.js", modules: { "entry.js": "export default class {}" } },
          capacity,
          dispatch,
          createHost: () => ({ host: {}, close }),
        });

        await expect(program.run(context)).rejects.toMatchObject({
          message,
          code: "CHILD_EXECUTION_FAILED",
          cause: { message, code: "EAGAIN" },
          termination: { kind: "stopped" },
        });
        await program.drain();
        expect(capacity.active).toBe(0);
        expect(close).toHaveBeenCalledOnce();
        expect(entrypointRuns).toBe(1);
        expect(codeFactoryCalls).toBe(0);
        expect(disposedEntrypoints).toBe(1);
        expect(disposedWorkers).toBe(1);
        if (kind === "compiled-rpc") expect(events).toEqual(["stopped"]);

        const retry = createChildWorkerProgram({
          executable: "/bin/tool",
          code: { mainModule: "entry.js", modules: { "entry.js": "export default class {}" } },
          capacity,
          dispatch,
          createHost: () => ({ host: {}, close }),
        });
        await expect(retry.run(context)).resolves.toEqual(exit);
        await retry.drain();
        expect(capacity.active).toBe(0);
        expect(close).toHaveBeenCalledTimes(2);
        expect(entrypointRuns).toBe(2);
        expect(codeFactoryCalls).toBe(1);
        expect(disposedEntrypoints).toBe(2);
        expect(disposedWorkers).toBe(2);
        if (kind === "compiled-rpc") expect(events).toEqual(["stopped", "host", "stopped"]);
      }),
  );

  it("keeps a quota-shaped guest failure ordinary across the compiled service proxy and lets the owner run again", async () =>
    withContext(async (context) => {
      const message = quotaCases[0]![1];
      const events: string[] = [];
      let entrypointRuns = 0;
      const get = vi.fn<WorkerLoader["get"]>().mockImplementation(() => {
        entrypointRuns++;
        return {
          getEntrypoint: vi.fn(() => ({
            [Symbol.dispose]: vi.fn(() => events.push("entrypoint-disposed")),
            async run(_command: unknown, target: unknown) {
              (target as { host(): object }).host();
              (target as { stopped(): void }).stopped();
              if (entrypointRuns === 1) throw new Error(message);
              return exit;
            },
          })),
          getDurableObjectClass: vi.fn(),
          [Symbol.dispose]: vi.fn(() => events.push("worker-disposed")),
        } as unknown as WorkerStub;
      });
      const compiledLoader = createCompiledChildWorkerLoader(
        { get, load: vi.fn() },
        new Map<string, WebAssembly.Module>(),
      );
      const dispatch = createWorkerLoaderDispatch<object>(
        throughWorkerLoaderRpcProxy(compiledLoader, events),
      );
      const capacity = new ChildWorkerCapacity(1, { owner: "test/worker-loader-rpc-guest-quota" });
      const close = vi.fn();
      const createProgram = () =>
        createChildWorkerProgram({
          executable: "/bin/tool",
          code: { mainModule: "entry.js", modules: { "entry.js": "export default class {}" } },
          capacity,
          dispatch,
          createHost: () => ({ host: {}, close }),
        });

      const program = createProgram();
      const failure = await program.run(context).catch((cause: unknown) => cause);

      expect(failure).toMatchObject({
        message,
        code: "CHILD_EXECUTION_FAILED",
        cause: { message },
        termination: { kind: "stopped" },
      });
      expect({ causeCode: (failure as { cause: { code?: string } }).cause.code, events }).toEqual({
        causeCode: undefined,
        events: ["host", "stopped", "entrypoint-disposed", "worker-disposed"],
      });
      await program.drain();
      expect(capacity.active).toBe(0);
      expect(events).toEqual(["host", "stopped", "entrypoint-disposed", "worker-disposed"]);
      expect(close).toHaveBeenCalledOnce();

      const retry = createProgram();
      await expect(retry.run(context)).resolves.toEqual(exit);
      await retry.drain();
      expect(capacity.active).toBe(0);
      expect(entrypointRuns).toBe(2);
      expect(close).toHaveBeenCalledTimes(2);
      expect(events).toEqual([
        "host",
        "stopped",
        "entrypoint-disposed",
        "worker-disposed",
        "host",
        "stopped",
        "entrypoint-disposed",
        "worker-disposed",
      ]);
    }));
});
