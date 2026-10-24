import { RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { createCompiledChildWorkerLoader } from "../CompiledChildWorkerLoader.ts";
import { createWorkerLoaderDispatch } from "../WorkerLoaderDispatch.ts";
import type { ChildWorkerInvocation } from "../ChildWorkerProgram.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

class InvocationTarget extends RpcTarget {}

const status = { exitCode: 17, signal: 0, coreDumped: false };
const input: ChildWorkerInvocation = {
  loaderId: "reply-owner",
  mainModule: "main.js",
  modules: { "main.js": "export default class {}" },
  command: { executable: "/bin/tool", argv: ["tool"], cwd: "/", env: {} },
};

function ownedExit(failRead = false) {
  const dispose = vi.fn();
  const reply = {
    get exitCode() {
      if (failRead) throw new Error("exit decode failed");
      return status.exitCode;
    },
    signal: 0,
    coreDumped: false,
    [Symbol.dispose]: dispose,
  };
  return { reply, dispose };
}

function nativeLoader(run: (command: unknown, target: unknown) => Promise<typeof status>) {
  const childDispose = vi.fn();
  const workerDispose = vi.fn();
  const worker = {
    getEntrypoint: () => ({ run, [Symbol.dispose]: childDispose }),
    getDurableObjectClass: vi.fn(),
    [Symbol.dispose]: workerDispose,
  };
  const loader: WorkerLoader = {
    get: vi.fn<WorkerLoader["get"]>().mockReturnValue(worker as unknown as WorkerStub),
    load: vi.fn(),
  };
  return { loader, childDispose, workerDispose };
}

describe("child dispatch RPC reply ownership", () => {
  it.each(["compiled", "service", "native"] as const)(
    "consumes the %s exit before returning plain exit data",
    async (kind) => {
      const { reply, dispose } = ownedExit();
      const native = nativeLoader(async (_command, target) => {
        if (kind !== "compiled") Reflect.get(target as object, "stopped").call(target);
        return reply;
      });
      const result =
        kind === "compiled"
          ? await createCompiledChildWorkerLoader(native.loader, new Map()).run(
              input,
              new InvocationTarget(),
            )
          : await createWorkerLoaderDispatch(
              kind === "native"
                ? native.loader
                : {
                    async run(_input, target) {
                      Reflect.get(target, "stopped").call(target);
                      return reply;
                    },
                  },
            ).run(input, new InvocationTarget());
      expect(result).toEqual(status);
      expect(dispose).toHaveBeenCalledOnce();
      expect(Symbol.dispose in result).toBe(false);
      expect(result).not.toBe(reply);
    },
  );

  it.each(["compiled", "service", "native"] as const)(
    "disposes the %s exit when reading its data fails",
    async (kind) => {
      const { reply, dispose } = ownedExit(true);
      const native = nativeLoader(async (_command, target) => {
        if (kind !== "compiled") Reflect.get(target as object, "stopped").call(target);
        return reply;
      });
      const result =
        kind === "compiled"
          ? createCompiledChildWorkerLoader(native.loader, new Map()).run(
              input,
              new InvocationTarget(),
            )
          : createWorkerLoaderDispatch(
              kind === "native"
                ? native.loader
                : {
                    async run(_input, target) {
                      Reflect.get(target, "stopped").call(target);
                      return reply;
                    },
                  },
            ).run(input, new InvocationTarget());
      const failure = await result.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ message: "exit decode failed" });
      expect(dispose).toHaveBeenCalledOnce();
      if (kind !== "service") {
        expect(native.childDispose).toHaveBeenCalledOnce();
        expect(native.workerDispose).toHaveBeenCalledOnce();
      }
    },
  );
});
