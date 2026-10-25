import type { KernelTscFileSystemPort } from "./KernelTscFileSystem.ts";
import { createKernelTscHostImports } from "./KernelTscHostImports.ts";
import { WasiExit } from "./wasi/internal_wasi_memory.ts";

const TSC_HOST_IMPORTS = Object.freeze(["fs", "fs_take"]);
const encoder = new TextEncoder();

export interface KernelTscReactorHost {
  readonly wasiImports: WebAssembly.Imports;
  initialize(instance: WebAssembly.Instance): void | Promise<void>;
  run(tsRun: () => number): number | Promise<number>;
}

export interface KernelTscReactorOptions {
  readonly filesystem: KernelTscFileSystemPort;
  readonly host: KernelTscReactorHost;
  readonly cwd: string;
  /** Includes argv[0], matching KernelProgramHost's process contract. */
  readonly args: readonly string[];
}

/** Executes one reactor instance; its global compiler state is never reused. */
export async function runKernelTscReactor(
  module: WebAssembly.Module,
  options: KernelTscReactorOptions,
): Promise<number> {
  assertHostImports(module);
  for (const value of [options.cwd, ...options.args]) {
    if (value.includes("\0")) {
      throw new TypeError("tsc-rs cwd and arguments must not contain NUL bytes");
    }
  }

  let instance: WebAssembly.Instance | undefined;
  const hostImports = createKernelTscHostImports(options.filesystem, () => {
    const memory = instance?.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new TypeError("tsc-rs instance does not export WebAssembly memory");
    }
    return memory;
  });
  const imports = createImports(module, options.host.wasiImports, hostImports);
  instance = new WebAssembly.Instance(module, imports);

  const exports = instance.exports as WebAssembly.Exports & {
    readonly memory: WebAssembly.Memory;
    readonly ts_input: (length: number) => number;
    readonly ts_run: () => number;
  };
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    typeof exports.ts_input !== "function" ||
    typeof exports.ts_run !== "function"
  ) {
    throw new TypeError("tsc-rs module is missing its reactor exports");
  }

  await options.host.initialize(instance);
  const input = encoder.encode([options.cwd, "0", ...options.args.slice(1)].join("\0"));
  const inputPointer = exports.ts_input(input.byteLength) >>> 0;
  new Uint8Array(exports.memory.buffer).set(input, inputPointer);
  try {
    return await options.host.run(exports.ts_run);
  } catch (error) {
    if (error instanceof WasiExit) return error.code;
    throw error;
  }
}

function createImports(
  module: WebAssembly.Module,
  wasiImports: WebAssembly.Imports,
  hostImports: WebAssembly.Imports,
): WebAssembly.Imports {
  const result = Object.create(null) as WebAssembly.Imports;
  for (const item of WebAssembly.Module.imports(module)) {
    if (item.kind !== "function") {
      throw new TypeError(`tsc-rs has unsupported ${item.kind} import ${item.module}.${item.name}`);
    }
    if (item.module !== "ts_host" && item.module !== "wasi_snapshot_preview1") {
      throw new TypeError(`tsc-rs has unsupported import namespace ${item.module}`);
    }
    const source = item.module === "ts_host" ? hostImports : wasiImports;
    const namespace = source[item.module];
    if (namespace === undefined || !Object.hasOwn(namespace, item.name)) {
      throw new TypeError(`tsc-rs host is missing import ${item.module}.${item.name}`);
    }
    const target =
      (result[item.module] as Record<string, WebAssembly.ImportValue> | undefined) ??
      Object.create(null);
    target[item.name] = namespace[item.name];
    result[item.module] = target;
  }
  return result;
}

function assertHostImports(module: WebAssembly.Module): void {
  const host = WebAssembly.Module.imports(module).filter((item) => item.module === "ts_host");
  const actual = host.map((item) => item.name).sort();
  const expected = [...TSC_HOST_IMPORTS].sort();
  if (actual.join("\0") !== expected.join("\0")) {
    throw new TypeError("tsc-rs module does not match the pinned ts_host ABI");
  }
}
