import {
  type KernelCoreutilsNamespace,
  type KernelCoreutilsPort,
} from "../kernel/KernelCoreutilsPort.ts";
import {
  KERNEL_COREUTILS_SPARSE_POINTERS,
  kernelCoreutilsPointerLength,
  type KernelCoreutilsSparsePointer,
} from "../kernel/KernelCoreutilsSparseMemory.ts";
import { MemoryRegions } from "./wasi/MemoryRegions.ts";

type WasmArgument = number | bigint;
type MemoryPlan = (
  regions: MemoryRegions,
  args: readonly WasmArgument[],
  memorySize: number,
) => void;

const plans = Object.fromEntries(
  Object.entries(KERNEL_COREUTILS_SPARSE_POINTERS).map(([namespace, calls]) => [
    namespace,
    Object.fromEntries(
      Object.entries(calls).map(([name, pointers]) => [name, sparsePlan(pointers)]),
    ),
  ]),
) as Readonly<Record<string, Readonly<Record<string, MemoryPlan>>>>;

interface JSPI {
  Suspending: new (
    fn: (...args: WasmArgument[]) => Promise<number | bigint>,
  ) => WebAssembly.ImportValue;
}

function sparsePlan(pointers: readonly KernelCoreutilsSparsePointer[]): MemoryPlan {
  return (regions, args, memorySize) => {
    for (const pointer of pointers) {
      const value = args[pointer.argument];
      const address = typeof value === "number" ? value : 0;
      const size = kernelCoreutilsPointerLength(pointer, args);
      if (pointer.maxBytes !== undefined && size > pointer.maxBytes) {
        const start = address >>> 0;
        if (start + size <= memorySize) {
          throw new RangeError("Coreutils path import exceeds the memory transfer limit");
        }
      }
      regions.add(address, size);
    }
  };
}

/** AgentOS imports keep their arguments sparse and execute against the parent's process port. */
export function createChildCoreutilsImports(options: {
  readonly module: WebAssembly.Module;
  readonly port: KernelCoreutilsPort;
}) {
  const wasm = WebAssembly as unknown as JSPI;
  if (typeof wasm.Suspending !== "function") {
    throw new Error("Coreutils child requires WebAssembly JSPI");
  }

  let memory: WebAssembly.Memory | undefined;
  const imports: WebAssembly.Imports = Object.create(null) as WebAssembly.Imports;
  for (const item of WebAssembly.Module.imports(options.module)) {
    if (item.module === "wasi_snapshot_preview1" || item.module === "wasi_unstable") continue;
    const namespacePlans = plans[item.module];
    const plan = namespacePlans?.[item.name];
    if (namespacePlans === undefined || plan === undefined || item.kind !== "function") {
      throw new TypeError(`Unsupported coreutils import: ${item.module}.${item.name}`);
    }
    const namespace = (imports[item.module] ??= Object.create(null)) as Record<
      string,
      WebAssembly.ImportValue
    >;
    namespace[item.name] = new wasm.Suspending(async (...args) => {
      if (memory === undefined) throw new Error("Coreutils child memory is not bound");
      const regions = new MemoryRegions(memory);
      plan(regions, args, memory.buffer.byteLength);
      const response = await options.port.callCoreutils({
        namespace: item.module as KernelCoreutilsNamespace,
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
      if (memory !== undefined) throw new Error("Coreutils child imports are already bound");
      if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
        throw new TypeError("Coreutils child lacks memory");
      }
      memory = instance.exports.memory;
    },
  };
}
