import type { KernelGitPort } from "../kernel/KernelGitPort.ts";
import { hasKernelGitMemoryPlan, planKernelGitMemory } from "../kernel/KernelGitMemoryPlan.ts";
import { MemoryRegions } from "./wasi/MemoryRegions.ts";

type WasmArgument = number | bigint;

/** Routes only the pinned module's Nimbus ABI through sparse argument ranges. */
export function createChildGitImports(options: {
  readonly module: WebAssembly.Module;
  readonly port: KernelGitPort;
}) {
  const wasm = WebAssembly as unknown as {
    Suspending: new (
      handler: (...args: WasmArgument[]) => Promise<number>,
    ) => WebAssembly.ImportValue;
  };
  if (typeof wasm.Suspending !== "function") throw new Error("Git child requires WebAssembly JSPI");

  let memory: WebAssembly.Memory | undefined;
  const imports: WebAssembly.Imports = Object.create(null) as WebAssembly.Imports;
  for (const item of WebAssembly.Module.imports(options.module)) {
    if (item.module === "wasi_snapshot_preview1" || item.module === "wasi_unstable") continue;
    const namespaceName =
      item.module === "nimbus_fs" || item.module === "nimbus_proc" ? item.module : undefined;
    if (
      namespaceName === undefined ||
      item.kind !== "function" ||
      !hasKernelGitMemoryPlan(namespaceName, item.name)
    ) {
      throw new TypeError(`Unsupported Git import ${item.module}.${item.name}`);
    }
    const namespace = (imports[item.module] ??= Object.create(null)) as Record<
      string,
      WebAssembly.ImportValue
    >;
    namespace[item.name] = new wasm.Suspending(async (...args) => {
      if (memory === undefined) throw new Error("Git child memory is not bound");
      const numericArgs = args.map((value) => {
        if (typeof value !== "number")
          throw new TypeError("Git Nimbus imports use only 32-bit arguments");
        return value;
      });
      const regions = new MemoryRegions(memory);
      planKernelGitMemory(
        namespaceName,
        item.name,
        numericArgs,
        memory.buffer.byteLength,
        (pointer, length) => regions.add(pointer, length),
      );
      const result = await options.port.callGit({
        namespace: namespaceName,
        name: item.name,
        args: numericArgs,
        memorySize: memory.buffer.byteLength,
        regions: regions.snapshot(),
      });
      regions.apply(result.regions);
      return result.value;
    });
  }

  return {
    imports,
    bind(instance: WebAssembly.Instance) {
      if (memory !== undefined) throw new Error("Git child imports are already bound");
      if (!(instance.exports.memory instanceof WebAssembly.Memory))
        throw new TypeError("Git child lacks memory");
      memory = instance.exports.memory;
    },
  };
}
