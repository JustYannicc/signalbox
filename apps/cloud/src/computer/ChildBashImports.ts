import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import { nimbusPlans, type NimbusMemoryPlan } from "./nimbus/NimbusPlans.ts";
import { MemoryRegions } from "./wasi/MemoryRegions.ts";

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
}) {
  const wasm = WebAssembly as unknown as {
    Suspending: new (handler: (...args: number[]) => Promise<number>) => WebAssembly.ImportValue;
  };
  if (typeof wasm.Suspending !== "function")
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
      regions.apply(response.regions);
      return response.value;
    });
  }
  return {
    imports,
    bind(instance: WebAssembly.Instance) {
      if (memory !== undefined) throw new Error("GNU Bash child imports are already bound");
      const exported = instance.exports.memory;
      if (!(exported instanceof WebAssembly.Memory))
        throw new TypeError("GNU Bash child lacks memory");
      memory = exported;
    },
  };
}
