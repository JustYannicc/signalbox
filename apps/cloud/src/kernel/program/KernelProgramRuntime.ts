import type { KernelCapability, KernelHandle, KernelResult } from "../KernelAbi.ts";
import { AgentOsDescriptorHost } from "../AgentOsDescriptorHost.ts";
import { AgentOsFileSystemHost } from "../AgentOsFileSystemHost.ts";
import type { AgentOsSpawnRequest } from "../AgentOsProcessWire.ts";
import { AgentOsProcessHost } from "../AgentOsProcessHost.ts";
import type { KernelFileSystem } from "../KernelFileSystem.ts";
import type { KernelProcessIdentity, KernelProcessTable } from "../KernelProcessTable.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import { currentKernelSignal } from "../process/KernelExecution.ts";
import { validateOptions } from "../wasi/internal_wasi_options.ts";
import { WasiLifecycle } from "../wasi/internal_wasi_lifecycle.ts";
import type { KernelPreparedProgram } from "./KernelPreparedProgram.ts";

export interface KernelInlineProgramContext {
  readonly filesystem: KernelFileSystem;
  readonly home: string | undefined;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export type KernelInlineProgram = (context: KernelInlineProgramContext) => number;

export type KernelProgramImplementation =
  | { readonly kind: "wasm"; readonly module: WebAssembly.Module }
  | { readonly kind: "javascript"; readonly runInline: KernelInlineProgram };

export interface KernelProgramBinding {
  /** Exact manifest passed to KernelProgramRegistry.register by the owner. */
  readonly manifest: {
    readonly name: string;
    readonly version: string;
    readonly abiVersion: number;
    readonly requiredCapabilities: readonly KernelCapability[];
    readonly entrypoint: string;
  };
  readonly implementation: KernelProgramImplementation;
}

export interface KernelWasiRuntimeOptions {
  readonly prepared: KernelPreparedProgram;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly asyncMode: boolean;
  readonly identity: KernelProcessIdentity | undefined;
  readonly signal: AbortSignal | undefined;
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
  readonly spawn: (request: AgentOsSpawnRequest) => Promise<KernelResult<KernelHandle<"process">>>;
}

/** Binds one precompiled module to its owned descriptor table and exact imports. */
export function createKernelWasiRuntime(
  module: WebAssembly.Module,
  options: KernelWasiRuntimeOptions,
): { readonly lifecycle: WasiLifecycle; readonly instance: WebAssembly.Instance } {
  const moduleImports = WebAssembly.Module.imports(module);
  const version = moduleImports.some((item) => item.module === "wasi_unstable")
    ? "unstable"
    : "preview1";
  const lifecycle = new WasiLifecycle(
    validateOptions({
      version,
      args: [...options.args],
      env: { ...options.env },
      returnOnExit: true,
      mounts: [],
    }),
    options.asyncMode,
    { table: options.prepared.filesystem.descriptors, ownership: "owned" },
  );

  const importObject = Object.create(null) as WebAssembly.Imports;
  for (const namespace of new Set(moduleImports.map((item) => item.module))) {
    if (namespace === "wasi_snapshot_preview1" || namespace === "wasi_unstable") {
      importObject[namespace] = lifecycle.wasiImport;
      continue;
    }
    if (namespace === "host_process") {
      const processHost = new AgentOsProcessHost({
        memory: () => lifecycle.memory.memory,
        processes: options.processes,
        wakes: options.wakes,
        ...(options.identity === undefined ? {} : { parent: options.identity.handle }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        spawn: options.spawn,
      });
      const descriptorHost = new AgentOsDescriptorHost({
        memory: () => lifecycle.memory.memory,
        descriptors: options.prepared.filesystem.descriptors,
        wakes: options.wakes,
        asyncMode: options.asyncMode,
        currentSignal: currentKernelSignal,
      });
      importObject[namespace] = hostProcessImports(
        moduleImports.filter((item) => item.module === namespace).map((item) => item.name),
        processHost,
        descriptorHost,
        options.asyncMode,
      );
      continue;
    }
    if (namespace === "host_fs") {
      const fileSystemHost = new AgentOsFileSystemHost({
        memory: () => lifecycle.memory.memory,
        fileSystem: options.prepared.filesystem,
      });
      const requested = new Set(
        moduleImports.filter((item) => item.module === namespace).map((item) => item.name),
      );
      const exact = Object.create(null) as Record<string, WebAssembly.ImportValue>;
      for (const [name, handler] of Object.entries(fileSystemHost.imports)) {
        if (requested.has(name)) exact[name] = handler;
      }
      importObject[namespace] = exact;
    }
  }

  return { lifecycle, instance: new WebAssembly.Instance(module, importObject) };
}

export function runInlineJavaScript(
  runInline: KernelInlineProgram,
  prepared: KernelPreparedProgram,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): number {
  const result: unknown = runInline({
    filesystem: prepared.filesystem,
    home: prepared.home,
    args: Object.freeze([...args]),
    env: Object.freeze({ ...env }),
  });
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(() => undefined);
    throw Object.assign(new Error("Inline program returned asynchronous work"), {
      code: "ERR_KERNEL_INLINE_ASYNC_UNSUPPORTED",
    });
  }
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < 0 ||
    result > 0xffff_ffff
  ) {
    throw Object.assign(new Error("Inline program returned an invalid exit code"), {
      code: "ERR_KERNEL_PROGRAM_EXIT",
    });
  }
  return result;
}

function hostProcessImports(
  names: readonly string[],
  processHost: AgentOsProcessHost,
  descriptorHost: AgentOsDescriptorHost,
  asyncMode: boolean,
): Record<string, WebAssembly.ImportValue> {
  const imports = Object.create(null) as Record<string, WebAssembly.ImportValue>;
  const processSuspending = new Set(processHost.suspendingImports);
  const descriptorSuspending = new Set(descriptorHost.suspendingImports);
  const wasm = WebAssembly as unknown as {
    Suspending?: new (fn: (...args: number[]) => unknown) => WebAssembly.ImportValue;
  };
  const processImports = Object.fromEntries(Object.entries(processHost.imports)) as Record<
    string,
    (...args: number[]) => unknown
  >;
  const descriptorImports = Object.fromEntries(Object.entries(descriptorHost.imports)) as Record<
    string,
    (...args: number[]) => unknown
  >;

  for (const name of new Set(names)) {
    const processImport = processImports[name];
    const descriptorImport = descriptorImports[name];
    if (processImport !== undefined && descriptorImport !== undefined) {
      throw Object.assign(new Error(`Duplicate AgentOS import: ${name}`), {
        code: "ERR_KERNEL_DUPLICATE_IMPORT",
      });
    }
    const handler = processImport ?? descriptorImport;
    if (handler === undefined) continue;
    const suspending = processSuspending.has(name) || descriptorSuspending.has(name);
    if (!suspending) {
      imports[name] = handler as WebAssembly.ImportValue;
      continue;
    }
    if (!asyncMode) {
      throw Object.assign(new Error(`AgentOS import requires asynchronous execution: ${name}`), {
        code: "ERR_KERNEL_INLINE_ASYNC_UNSUPPORTED",
      });
    }
    if (typeof wasm.Suspending !== "function") {
      throw Object.assign(new Error("AgentOS asynchronous imports require WebAssembly JSPI"), {
        code: "ERR_KERNEL_JSPI_UNAVAILABLE",
      });
    }
    imports[name] = new wasm.Suspending(handler as (...args: number[]) => unknown);
  }
  return imports;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}
