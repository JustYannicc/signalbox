// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  validateArray,
  validateBoolean,
  validateInt32,
  validateObject,
  validateOneOf,
} from "./compat.ts";
import { ERR_INVALID_ARG_VALUE } from "./compat.ts";
import type { AsyncStorage, Mount, Storage } from "../storage.ts";
import type { WasiStdio } from "./internal_wasi_fs.ts";

export interface WASIOptions {
  version: "unstable" | "preview1";
  args?: string[];
  env?: Record<string, string | undefined>;
  preopens?: Record<string, string>;
  stdin?: number;
  stdout?: number;
  stderr?: number;
  returnOnExit?: boolean;
  /** Additional explicit roots backed by application-provided storage. */
  mounts?: Mount[];
  /** Borrowed streams; the WASI host never closes them. */
  stdio?: [WasiStdio, WasiStdio, WasiStdio];
}

export interface AsyncWASIOptions extends Omit<WASIOptions, "mounts"> {
  mounts?: Mount<AsyncStorage>[];
}

export interface ValidatedOptions {
  version: WASIOptions["version"];
  args: string[];
  env: string[];
  preopens: Array<[string, string]>;
  stdio: [number, number, number];
  returnOnExit: boolean;
  mounts: Mount<Storage | AsyncStorage>[];
  streams?: [WasiStdio, WasiStdio, WasiStdio];
}

export function validateOptions(options: WASIOptions | AsyncWASIOptions): ValidatedOptions {
  validateObject(options, "options");
  validateOneOf(options.version, "options.version", ["unstable", "preview1"]);
  if (options.args !== undefined) validateArray(options.args, "options.args");
  if (options.env !== undefined) validateObject(options.env, "options.env");
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
  if (options.mounts !== undefined) {
    validateArray(options.mounts, "options.mounts");
  }
  if (options.stdio !== undefined) {
    validateArray(options.stdio, "options.stdio");
    const streams: readonly WasiStdio[] = options.stdio;
    if (streams.length !== 3) {
      throw new ERR_INVALID_ARG_VALUE("options.stdio", options.stdio);
    }
    options.stdio.forEach((stream, index) => {
      validateObject(stream, `options.stdio[${index}]`);
    });
  }
  const args = (options.args ?? []).map(String);
  const env = Object.entries(options.env ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  if ([...args, ...env].some((value) => value.includes("\0"))) {
    throw new ERR_INVALID_ARG_VALUE("options", options, "must not contain NUL");
  }
  const result: ValidatedOptions = {
    version: options.version,
    args,
    env,
    preopens: Object.entries(options.preopens ?? {}).map(([guest, host]) => [guest, host]),
    stdio: [stdin, stdout, stderr],
    returnOnExit: options.returnOnExit ?? true,
    mounts: [...(options.mounts ?? [])],
  };
  if (options.stdio !== undefined) result.streams = options.stdio;
  return result;
}
