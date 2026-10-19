import { ABI_VERSION, KernelProgramRegistry, callKernel } from "../../kernel/KernelAbi.ts";
import { createKernelBashProgram } from "../../kernel/KernelBashProgram.ts";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import { KernelProgramHost, type KernelProgramBinding } from "../../kernel/KernelProgramHost.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildBash } from "../ChildBash.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { bashCredentials, childBashFixture, exited, text } from "./ChildBashFixture.ts";

export function childBashLifetimeFixture(module: WebAssembly.Module, child = true) {
  const files = childBashFixture();
  const capacity = new ChildWorkerCapacity(1);
  const entered = Promise.withResolvers<KernelAsyncProgramContext>();
  const aborted = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let rootContext: KernelAsyncProgramContext | undefined;
  let closeWorker: (() => Promise<void>) | undefined;
  const implementation = child
    ? createChildWorkerProgram({
        executable: "/bin/bash",
        code: { mainModule: "test", modules: {} },
        capacity,
        createHost(context) {
          rootContext = context;
          const owner = createKernelBashHost({ context, credentials: bashCredentials });
          closeWorker = owner.close;
          return {
            host: { port: owner.port, pid: owner.pid },
            exited: owner.exited,
            close: owner.close,
          };
        },
        dispatch: {
          async run(input, owner) {
            const bash = createChildBash({
              module,
              credentials: bashCredentials,
              pid: owner.pid,
              port: owner.port,
              args: input.command.argv,
              env: input.command.env,
            });
            try {
              return await bash.run();
            } finally {
              await bash.drain();
            }
          },
        },
      })
    : {
        kind: "async" as const,
        run(context: KernelAsyncProgramContext) {
          rootContext = context;
          return createKernelBashProgram({ module, credentials: bashCredentials }).run(context);
        },
      };
  const registry = new KernelProgramRegistry();
  const bindings = new Map<string, KernelProgramBinding>();
  const add = (path: string, implementation: KernelProgramBinding["implementation"]) => {
    const manifest = {
      name: path,
      version: "1",
      abiVersion: ABI_VERSION,
      requiredCapabilities: ["process.wait" as const],
      entrypoint: path,
    };
    if (registry.register(manifest).status !== "ok") throw new Error("Registration failed");
    bindings.set(path, { manifest, implementation });
    files.write(path, "", 0o755);
  };
  add("/bin/bash", implementation);
  add("/bin/blocked", {
    kind: "async",
    async run(context) {
      entered.resolve(context);
      const cancelled = Promise.withResolvers<never>();
      const abort = () => {
        aborted.resolve();
        cancelled.reject(new Error("Background process cancelled"));
      };
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        if (context.signal.aborted) abort();
        await Promise.race([gate.promise, cancelled.promise]);
        context.filesystem.write(1, text("background output"), null);
        return exited(5);
      } finally {
        context.signal.removeEventListener("abort", abort);
      }
    },
  });
  add("/bin/broken", {
    kind: "async",
    async run() {
      throw new Error("Replacement execution failed");
    },
  });
  const programs = new KernelProgramHost({ registry, wakes: files.wakes, programs: bindings });
  return {
    files,
    programs,
    capacity,
    entered: entered.promise,
    aborted: aborted.promise,
    rootContext: () => {
      if (rootContext === undefined) throw new Error("Bash has not started");
      return rootContext;
    },
    release: () => gate.resolve(),
    closeWorker() {
      if (closeWorker === undefined) throw new Error("Child worker has not started");
      return closeWorker();
    },
    start(script: string) {
      const prepared = programs.prepare({ filesystem: files.filesystem, home: "/workspace" });
      const resolved = programs.resolve("/bin/bash");
      if (resolved.status !== "ok") throw new Error("Bash resolution failed");
      const spawned = callKernel(programs.backend(prepared), "process.spawn", {
        program: resolved.value,
        args: ["bash", "--noprofile", "--norc", "-c", script],
        env: files.context.env,
      });
      if (spawned.status !== "ok") throw new Error("Bash admission failed");
      return { handle: spawned.value, exited: programs.exitStatus(spawned.value) };
    },
    async close() {
      gate.resolve();
      await programs.processes.dispose();
      await files.close();
    },
  };
}
