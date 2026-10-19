import type { KernelBusyboxPort } from "../kernel/KernelBusyboxPort.ts";
import { MemoryRegions } from "./wasi/MemoryRegions.ts";

type Plan = (regions: MemoryRegions, args: readonly number[]) => void;
const none: Plan = () => {};
const plans: Readonly<Record<string, Plan>> = {
  identity: none,
  startup_cwd: (regions, args) => regions.add(args[0]!, args[1]!),
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

/** Nimbus imports use their own ABI; standard WASI is composed by ChildBusybox. */
export function createChildBusyboxImports(options: {
  readonly module: WebAssembly.Module;
  readonly port: KernelBusyboxPort;
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
      plan(regions, args);
      const result = await options.port.callBusybox({
        name: item.name,
        args,
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
      if (memory !== undefined) throw new Error("BusyBox child imports are already bound");
      if (!(instance.exports.memory instanceof WebAssembly.Memory))
        throw new TypeError("BusyBox child lacks memory");
      memory = instance.exports.memory;
    },
  };
}
