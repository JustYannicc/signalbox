// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import cffs from "./native.ts";
import {
  enterCurrentKernelCpuUser,
  runCurrentKernelCpuAsyncSystemImport,
  runCurrentKernelCpuSystemImport,
} from "../KernelCpuExecution.ts";
import { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE } from "./compat.ts";
import { validateObject } from "./compat.ts";
import { WasiFileSystem, type WasiDescriptorContext } from "./internal_wasi_fs.ts";
import { WasiHost } from "./internal_wasi_host.ts";
import { WasiExit, WasiMemory } from "./internal_wasi_memory.ts";
import { nativeStorage } from "./native.ts";
import { mapErrno, runAsync, runSync, type WasiCall } from "./internal_wasi_calls.ts";
import type { ValidatedOptions } from "./internal_wasi_options.ts";

type WasmArgument = number | bigint;
type WasmFunction = (...args: WasmArgument[]) => unknown;
type ImportFunction = (...args: WasmArgument[]) => WasiCall<number>;
export type WasiImportArgumentTransform = (
  name: string,
  args: readonly WasmArgument[],
) => readonly WasmArgument[];
// signalbox: kernel virtual devices adapt raw syscalls inside the existing accounting/JSPI boundary.
export type WasiFileSystemImportAdapter = (
  memory: WasiMemory,
  imports: WasiFileSystem["imports"],
) => WasiFileSystem["imports"];
interface Instance {
  exports: Record<string, unknown>;
}

interface JSPI {
  Suspending: new (fn: (...args: WasmArgument[]) => Promise<number>) => WebAssembly.ImportValue;
  promising(fn: WasmFunction): (...args: WasmArgument[]) => Promise<unknown>;
}

export interface FinalizeBindingsOptions {
  memory?: WebAssembly.Memory;
}

function stateError(message: string): Error {
  return Object.assign(new Error(message), {
    code: "ERR_WASI_ALREADY_STARTED",
  });
}

function getJSPI(): JSPI {
  const wasm = WebAssembly as unknown as JSPI;
  if (typeof wasm.Suspending !== "function" || typeof wasm.promising !== "function") {
    throw new Error("The WASI async host requires WebAssembly JSPI support");
  }
  return wasm;
}

/** Owns one command or reactor and its descriptors, never the supplied storage. */
export class WasiLifecycle {
  readonly memory = new WasiMemory();
  readonly filesystem: WasiFileSystem;
  readonly wasiImport = Object.create(null) as WebAssembly.ModuleImports;
  readonly #async: boolean;
  readonly #returnOnExit: boolean;
  readonly #version: string;
  #instance: Instance | undefined;
  #active = false;
  #closed = false;
  #ready = false;
  #closing: Promise<void> | undefined;

  constructor(
    options: ValidatedOptions,
    asyncMode: boolean,
    descriptorContext?: WasiDescriptorContext,
    transformArguments?: WasiImportArgumentTransform,
    adaptFileSystemImports?: WasiFileSystemImportAdapter,
  ) {
    this.#async = asyncMode;
    this.#returnOnExit = options.returnOnExit;
    this.#version = options.version;
    const mounts = [...options.mounts];
    if (descriptorContext === undefined) {
      for (const [path, nativePath] of options.preopens) {
        mounts.push({ path, storage: nativeStorage(nativePath) });
      }
    }
    const streams =
      options.streams ??
      options.stdio.map((fd) => ({
        readInto: (target: Uint8Array): number => cffs.read(fd, [target], { position: null }),
        write: (source: Uint8Array): number => cffs.write(fd, [source], { position: null }),
      }));
    this.filesystem = new WasiFileSystem(this.memory, mounts, streams, descriptorContext);
    const host = new WasiHost(
      this.memory,
      options.args,
      options.env,
      asyncMode,
      this.filesystem.descriptors,
    );
    const imports = {
      ...host.imports,
      ...(adaptFileSystemImports?.(this.memory, this.filesystem.imports) ??
        this.filesystem.imports),
    } as unknown as Record<string, ImportFunction>;
    for (const [name, handler] of Object.entries(imports)) {
      // The suspending wrapper sits directly on the Wasm import. An async JS
      // filesystem callback nested under another synchronous JS frame cannot
      // provide this suspension boundary.
      this.wasiImport[name] = asyncMode
        ? new (getJSPI().Suspending)(async (...args): Promise<number> => {
            try {
              if (this.#closed) throw stateError("WASI has been closed");
              return await runCurrentKernelCpuAsyncSystemImport((runSystem) =>
                runAsync(handler(...(transformArguments?.(name, args) ?? args)), runSystem).catch(
                  (error: unknown) => runSystem(() => mapErrno(error)),
                ),
              );
            } catch (error) {
              return runCurrentKernelCpuSystemImport(() => mapErrno(error));
            }
          })
        : (...args: WasmArgument[]): number => {
            return runCurrentKernelCpuSystemImport(() => {
              try {
                if (this.#closed) throw stateError("WASI has been closed");
                return runSync(handler(...(transformArguments?.(name, args) ?? args)));
              } catch (error) {
                return mapErrno(error);
              }
            });
          };
    }
  }

  getImportObject(): WebAssembly.Imports {
    return {
      [this.#version === "unstable" ? "wasi_unstable" : "wasi_snapshot_preview1"]: this.wasiImport,
    };
  }

  #bind(instance: object, options: FinalizeBindingsOptions = {}): void {
    if (this.#instance !== undefined || this.#closed) {
      throw stateError("WASI instance has already been started");
    }
    validateObject(instance, "instance");
    const candidate = instance as Instance;
    validateObject(candidate.exports, "instance.exports");
    const memory = options.memory ?? candidate.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new ERR_INVALID_ARG_TYPE("instance.exports.memory", "WebAssembly.Memory", memory);
    }
    this.memory.set(memory);
    this.#instance = candidate;
  }

  finalizeBindings(instance: object, options: FinalizeBindingsOptions = {}): void {
    this.#bind(instance, options);
    try {
      runSync(this.filesystem.initialize());
      this.#ready = true;
    } catch (error) {
      this.#fail(error);
    }
  }

  #exports(): Record<string, unknown> {
    if (this.#instance === undefined) throw stateError("WASI has not been bound");
    return this.#instance.exports;
  }

  #entry(command: true): WasmFunction;
  #entry(command: false): WasmFunction | undefined;
  #entry(command: boolean): WasmFunction | undefined {
    const exports = this.#exports();
    const forbidden = command ? "_initialize" : "_start";
    if (exports[forbidden] !== undefined) {
      throw new ERR_INVALID_ARG_VALUE(`instance.exports.${forbidden}`, exports[forbidden]);
    }
    const name = command ? "_start" : "_initialize";
    const entry = exports[name];
    if (!command && entry === undefined) return undefined;
    if (typeof entry !== "function") {
      throw new ERR_INVALID_ARG_TYPE(`instance.exports.${name}`, "Function", entry);
    }
    return entry as WasmFunction;
  }

  start(instance: object): number {
    this.finalizeBindings(instance);
    let code = 0;
    const leaveUser = enterCurrentKernelCpuUser();
    try {
      this.#entry(true)();
    } catch (error) {
      if (error instanceof WasiExit && this.#returnOnExit) code = error.code;
      else this.#fail(error);
    } finally {
      leaveUser();
    }
    this.close();
    return code;
  }

  async startAsync(instance: object): Promise<number> {
    this.#bind(instance);
    let code = 0;
    try {
      await this.#prepareAsync();
      await this.runAsync(this.#entry(true));
    } catch (error) {
      if (error instanceof WasiExit && this.#returnOnExit) code = error.code;
      else await this.#failAsync(error);
    }
    await this.closeAsync();
    return code;
  }

  initialize(instance: object): void {
    this.finalizeBindings(instance);
    const leaveUser = enterCurrentKernelCpuUser();
    try {
      this.#entry(false)?.();
    } catch (error) {
      this.#fail(error);
    } finally {
      leaveUser();
    }
  }

  async initializeAsync(instance: object): Promise<void> {
    this.#bind(instance);
    try {
      await this.#prepareAsync();
      const entry = this.#entry(false);
      if (entry !== undefined) await this.runAsync(entry);
    } catch (error) {
      await this.#failAsync(error);
    }
  }

  async runAsync(fn: WasmFunction, ...args: WasmArgument[]): Promise<unknown> {
    if (!this.#async || !this.#ready || this.#closed || this.#active) {
      throw stateError("WASI reactor is unavailable or already executing");
    }
    if (!Object.values(this.#exports()).includes(fn)) {
      throw new ERR_INVALID_ARG_VALUE("fn", fn, "must be an export of the bound instance");
    }
    this.#active = true;
    let leaveUser: (() => void) | undefined;
    try {
      leaveUser = enterCurrentKernelCpuUser();
      return await getJSPI().promising(fn)(...args);
    } finally {
      try {
        leaveUser?.();
      } finally {
        this.#active = false;
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#active) throw stateError("WASI is still executing");
    this.#closed = true;
    runSync(this.filesystem.close());
  }

  async closeAsync(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    if (this.#closed) return;
    if (this.#active) throw stateError("WASI is still executing");
    this.#closed = true;
    this.#closing = runAsync(this.filesystem.close());
    return this.#closing;
  }

  async #prepareAsync(): Promise<void> {
    this.#active = true;
    try {
      await runAsync(this.filesystem.initialize());
      this.#ready = true;
    } finally {
      this.#active = false;
    }
  }

  #fail(error: unknown): never {
    try {
      this.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "WASI execution and cleanup failed");
    }
    throw error;
  }

  async #failAsync(error: unknown): Promise<never> {
    try {
      await this.closeAsync();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "WASI execution and cleanup failed");
    }
    throw error;
  }
}
