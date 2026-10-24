import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import { disposeKernelRpcReply } from "../kernel/KernelRpcReply.ts";
import { nimbusPlans, type NimbusMemoryPlan } from "./nimbus/NimbusPlans.ts";
import { MemoryRegions } from "./wasi/MemoryRegions.ts";
import type {
  KernelBashImportCall,
  KernelBashOperationEffect,
  KernelBashOperationResult,
} from "../kernel/KernelBashCheckpoint.ts";
import type { BashAsyncifyOperationHooks } from "../kernel/KernelBashCheckpoint.ts";

const none: NimbusMemoryPlan = () => {};
const plans: Readonly<Record<string, NimbusMemoryPlan>> = {
  ...nimbusPlans,
  capture_cwd: (regions, args) => regions.add(args[0]!, args[1]!),
  pipe: (regions, args) => regions.add(args[0]!, 8),
  fd_getfd: none,
  fd_getflags: none,
  fd_setfd: none,
  dup: none,
  dup2: none,
  kill: none,
  getppid: none,
  getpgid: none,
};

export function createChildBashImports(options: {
  readonly module: WebAssembly.Module;
  readonly port: Pick<KernelBashPort, "callBash">;
  readonly asyncify?: BashAsyncifyOperationHooks;
}) {
  const wasm = WebAssembly as unknown as {
    Suspending: new (handler: (...args: number[]) => Promise<number>) => WebAssembly.ImportValue;
  };
  if (options.asyncify === undefined && typeof wasm.Suspending !== "function")
    throw new Error("GNU Bash child requires WebAssembly JSPI");
  let memory: WebAssembly.Memory | undefined;
  const imports: WebAssembly.Imports = {};
  for (const item of WebAssembly.Module.imports(options.module)) {
    const namespace = item.module;
    const plan =
      namespace === "nimbus_proc"
        ? plans[item.name]
        : namespace === "env" && item.name === "umask"
          ? none
          : undefined;
    if (plan === undefined) continue;
    if (item.kind !== "function")
      throw new TypeError(`Invalid GNU Bash import ${namespace}.${item.name}`);
    const target = (imports[namespace] ??= {}) as Record<string, WebAssembly.ImportValue>;
    // The pinned image only instruments nimbus_proc and WASI imports for Asyncify.
    if (options.asyncify !== undefined && namespace !== "env") {
      target[item.name] = (...args: number[]) => {
        const resumed = options.asyncify!.landing();
        if (resumed !== undefined) return resumed;
        if (memory === undefined) throw new Error("GNU Bash child memory is not bound");
        const regions = new MemoryRegions(memory);
        plan(regions, args, memory.buffer.byteLength);
        const request = {
          namespace: namespace as "nimbus_proc" | "env",
          name: item.name,
          args,
          memorySize: memory.buffer.byteLength,
          regions: regions.snapshot(),
        };
        return options.asyncify!.suspend(
          { kind: "bash", request },
          { namespace: namespace as "nimbus_proc" | "env", name: item.name, args },
        );
      };
      continue;
    }
    target[item.name] = new wasm.Suspending(async (...args) => {
      if (memory === undefined) throw new Error("GNU Bash child memory is not bound");
      const regions = new MemoryRegions(memory);
      plan(regions, args, memory.buffer.byteLength);
      const response = await options.port.callBash({
        namespace: namespace as "nimbus_proc" | "env",
        name: item.name,
        args,
        memorySize: memory.buffer.byteLength,
        regions: regions.snapshot(),
      });
      try {
        regions.apply(response.regions);
        return response.value;
      } finally {
        disposeKernelRpcReply(response);
      }
    });
  }
  return {
    imports,
    applyOperation(
      call: KernelBashImportCall,
      result: KernelBashOperationResult,
    ): KernelBashOperationEffect {
      if (result.kind !== "bash") throw new TypeError("Bash import received a non-Bash result");
      if (memory === undefined) throw new Error("GNU Bash child memory is not bound");
      const plan =
        call.namespace === "nimbus_proc"
          ? plans[call.name]
          : call.namespace === "env" && call.name === "umask"
            ? none
            : undefined;
      if (plan === undefined)
        throw new TypeError(`Unsupported GNU Bash import ${call.namespace}.${call.name}`);
      const args = call.args.map(Number);
      const regions = new MemoryRegions(memory);
      plan(regions, args, memory.buffer.byteLength);
      regions.apply(result.value.regions);
      return { kind: "resume", value: result.value.value };
    },
    bind(instance: WebAssembly.Instance) {
      if (memory !== undefined) throw new Error("GNU Bash child imports are already bound");
      const exported = instance.exports.memory;
      if (!(exported instanceof WebAssembly.Memory))
        throw new TypeError("GNU Bash child lacks memory");
      memory = exported;
    },
  };
}
