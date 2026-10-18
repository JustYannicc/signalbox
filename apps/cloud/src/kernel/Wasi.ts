// Copyright (c) 2017-2022 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
import {
  validateArray,
  validateBoolean,
  validateObject,
  validateOneOf,
  validateInt32,
} from "./wasi/compat.ts";

import { ERR_METHOD_NOT_IMPLEMENTED } from "./wasi/compat.ts";

import { WasiLifecycle } from "./wasi/internal_wasi_lifecycle.ts";
import { validateOptions } from "./wasi/internal_wasi_options.ts";
import type { WASIOptions, AsyncWASIOptions } from "./wasi/internal_wasi_options.ts";
import type { FinalizeBindingsOptions } from "./wasi/internal_wasi_lifecycle.ts";

export type { WASIOptions, AsyncWASIOptions };
export type { Storage, AsyncStorage, Mount } from "./storage.ts";
export type { WasiPollResult, WasiStdio } from "./wasi/internal_wasi_fs.ts";

// The carry is explicitly imported until node:wasi ships this API.
const enabled = true;

export class WASI {
  readonly #host: WasiLifecycle;

  constructor(options: WASIOptions = { version: "unstable" }) {
    validateObject(options, "options");
    validateOneOf(options.version, "options.version", ["unstable", "preview1"]);
    if (options.args !== undefined) {
      validateArray(options.args, "options.args");
    }
    if (options.env !== undefined) {
      validateObject(options.env, "options.env");
    }
    if (options.preopens !== undefined) {
      validateObject(options.preopens, "options.preopens");
    }
    const { stdin = 0, stdout = 1, stderr = 2 } = options;
    validateInt32(stdin, "options.stdin", 0);
    validateInt32(stdout, "options.stdout", 0);
    validateInt32(stderr, "options.stderr", 0);

    if (options.returnOnExit !== undefined) {
      validateBoolean(options.returnOnExit, "options.returnOnExit");
    }

    if (!enabled) throw new ERR_METHOD_NOT_IMPLEMENTED("WASI");
    this.#host = new WasiLifecycle(validateOptions(options), false);
  }

  get wasiImport(): WebAssembly.ModuleImports {
    return this.#host.wasiImport;
  }

  finalizeBindings(instance: object, options: FinalizeBindingsOptions = {}): void {
    if (!enabled) throw new ERR_METHOD_NOT_IMPLEMENTED("WASI.finalizeBindings");
    this.#host.finalizeBindings(instance, options);
  }

  start(instance: object): number {
    if (!enabled) throw new ERR_METHOD_NOT_IMPLEMENTED("WASI.start");
    return this.#host.start(instance);
  }

  initialize(instance: object): void {
    if (!enabled) throw new ERR_METHOD_NOT_IMPLEMENTED("WASI.initialize");
    this.#host.initialize(instance);
  }

  close(): void {
    if (!enabled) throw new ERR_METHOD_NOT_IMPLEMENTED("WASI.close");
    this.#host.close();
  }

  getImportObject(): WebAssembly.Imports {
    return enabled ? this.#host.getImportObject() : {};
  }
}

/** Explicit asynchronous lifecycle for preview1 guests with async providers. */
export class AsyncWASI {
  readonly #host: WasiLifecycle;

  constructor(options: AsyncWASIOptions = { version: "preview1" }) {
    if (!enabled) throw new ERR_METHOD_NOT_IMPLEMENTED("AsyncWASI");
    this.#host = new WasiLifecycle(validateOptions(options), true);
  }

  get wasiImport(): WebAssembly.ModuleImports {
    return this.#host.wasiImport;
  }

  getImportObject(): WebAssembly.Imports {
    return this.#host.getImportObject();
  }

  start(instance: object): Promise<number> {
    return this.#host.startAsync(instance);
  }

  initialize(instance: object): Promise<void> {
    return this.#host.initializeAsync(instance);
  }

  /** Enters a reactor export through JSPI. Concurrent calls are rejected. */
  run(
    fn: (...args: Array<number | bigint>) => unknown,
    ...args: Array<number | bigint>
  ): Promise<unknown> {
    return this.#host.runAsync(fn, ...args);
  }

  close(): Promise<void> {
    return this.#host.closeAsync();
  }
}

export default { WASI, AsyncWASI };
