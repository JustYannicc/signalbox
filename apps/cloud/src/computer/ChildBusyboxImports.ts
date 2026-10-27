import type { KernelBusyboxPort } from "../kernel/KernelBusyboxPort.ts";
import { disposeKernelRpcReply } from "../kernel/KernelRpcReply.ts";
import { nimbusPlans, type NimbusMemoryPlan } from "./nimbus/NimbusPlans.ts";
import { MemoryRegions } from "./wasi/MemoryRegions.ts";

const plans: Readonly<Record<string, NimbusMemoryPlan>> = {
  ...nimbusPlans,
  identity: () => {},
};

/** Nimbus imports use their own ABI; standard WASI is composed by ChildBusybox. */
export function createChildBusyboxImports(options: {
  readonly module: WebAssembly.Module;
  readonly port: Pick<KernelBusyboxPort, "callBusybox">;
}) {
  const wasm = WebAssembly as unknown as {
    Suspending: new (handler: (...args: number[]) => Promise<number>) => WebAssembly.ImportValue;
  };
  if (typeof wasm.Suspending !== "function")
    throw new Error("BusyBox child requires WebAssembly JSPI");
  let memory: WebAssembly.Memory | undefined;
  const imports: WebAssembly.Imports = Object.create(null) as WebAssembly.Imports;
  for (const item of WebAssembly.Module.imports(options.module)) {
    if (item.module === "wasi_snapshot_preview1") continue;
    if (
      item.module !== "nimbus_proc" ||
      item.kind !== "function" ||
      !Object.hasOwn(plans, item.name)
    )
      throw new TypeError(`Unsupported BusyBox import: ${item.module}.${item.name}`);
    const plan = plans[item.name]!;
    const namespace = (imports.nimbus_proc ??= Object.create(null)) as Record<
      string,
      WebAssembly.ImportValue
    >;
    namespace[item.name] = new wasm.Suspending(async (...args) => {
      if (memory === undefined) throw new Error("BusyBox child memory is not bound");
      const regions = new MemoryRegions(memory);
      plan(regions, args, memory.buffer.byteLength);
      const result = await options.port.callBusybox({
        name: item.name,
        args,
        memorySize: memory.buffer.byteLength,
        regions: regions.snapshot(),
      });
      try {
        regions.apply(result.regions);
        return result.value;
      } finally {
        disposeKernelRpcReply(result);
      }
    });
  }
  return {
    imports,
    bind(instance: WebAssembly.Instance) {
      if (memory !== undefined) throw new Error("BusyBox child imports are already bound");
      if (!(instance.exports.memory instanceof WebAssembly.Memory))
        throw new TypeError("BusyBox child lacks memory");
      memory = instance.exports.memory;
    },
  };
}
