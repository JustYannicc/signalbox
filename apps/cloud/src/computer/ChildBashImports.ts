import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import { MemoryRegions } from "./wasi/MemoryRegions.ts";

type Plan = (regions: MemoryRegions, args: readonly number[]) => void;
const none: Plan = () => {};
const plans: Readonly<Record<string, Plan>> = {
  startup_cwd: (regions, args) => regions.add(args[0]!, args[1]!),
  capture_cwd: (regions, args) => regions.add(args[0]!, args[1]!),
  pipe: (regions, args) => regions.add(args[0]!, 8),
  fd_getfd: none,
  dup: none,
  dup2: none,
  kill: none,
  getppid: none,
  getpgid: none,
  stat_metadata(regions, args) {
    if (args[1] !== 0) regions.add(args[1]!, args[2]!);
    regions.add(args[4]!, 12);
  },
  account(regions, args) {
    if (args[1] === 1) regions.add(args[2]!, args[3]!);
    regions.add(args[5]!, args[6]!);
    regions.add(args[7]!, 4);
  },
  chmod: (regions, args) => regions.add(args[0]!, args[1]!),
  fchmod: none,
  chown(regions, args) {
    if (args[1] !== 0) regions.add(args[1]!, args[2]!);
  },
};

export function createChildBashImports(options: {
  readonly module: WebAssembly.Module;
  readonly port: KernelBashPort;
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
      plan(regions, args);
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
