// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/* eslint-disable require-yield -- WASI handlers share one generator protocol for synchronous and suspending imports. */

import { complete, type WasiCall } from "./internal_wasi_calls.ts";
import type { WasiDescriptorTable } from "./internal_wasi_descriptors.ts";
import { WasiClock } from "./internal_wasi_clock.ts";
import { WasiExit, WasiMemory } from "./internal_wasi_memory.ts";
import { WasiPoller } from "./internal_wasi_poll.ts";

const ERRNO_SUCCESS = 0;
const ERRNO_NOSYS = 52;
const ERRNO_NOTSUP = 58;

const RANDOM_CHUNK_BYTES = 65_536;

export class WasiHost {
  readonly #memory: WasiMemory;
  readonly #args: string[];
  readonly #env: string[];
  readonly #asyncMode: boolean;
  readonly #clock = new WasiClock();
  readonly #poller: WasiPoller;
  readonly imports = {
    args_sizes_get: (countPointer: number, sizePointer: number): WasiCall<number> =>
      this.#argsSizesGet(countPointer, sizePointer),
    args_get: (argsPointer: number, bufferPointer: number): WasiCall<number> =>
      this.#argsGet(argsPointer, bufferPointer),
    environ_sizes_get: (countPointer: number, sizePointer: number): WasiCall<number> =>
      this.#environSizesGet(countPointer, sizePointer),
    environ_get: (environPointer: number, bufferPointer: number): WasiCall<number> =>
      this.#environGet(environPointer, bufferPointer),
    clock_res_get: (clockId: number, resolutionPointer: number): WasiCall<number> =>
      this.#clockResGet(clockId, resolutionPointer),
    clock_time_get: (clockId: number, _precision: bigint, timePointer: number): WasiCall<number> =>
      this.#clockTimeGet(clockId, _precision, timePointer),
    random_get: (pointer: number, length: number): WasiCall<number> =>
      this.#randomGet(pointer, length),
    sched_yield: (): WasiCall<number> => this.#schedYield(),
    proc_exit: (code: number): WasiCall<never> => this.#exit(code),
    proc_raise: (_signal: number): WasiCall<number> => this.#noSys(),
    poll_oneoff: (
      subscriptionsPointer: number,
      eventsPointer: number,
      count: number,
      eventsCountPointer: number,
    ): WasiCall<number> =>
      this.#pollOneoff(subscriptionsPointer, eventsPointer, count, eventsCountPointer),
    sock_accept: (_fd: number, _flags: number, _fdPointer: number): WasiCall<number> =>
      this.#noSys(),
    sock_recv: (
      _fd: number,
      _iovs: number,
      _iovsLength: number,
      _flags: number,
      _readLengthPointer: number,
      _outputFlagsPointer: number,
    ): WasiCall<number> => this.#noSys(),
    sock_send: (
      _fd: number,
      _iovs: number,
      _iovsLength: number,
      _flags: number,
      _writtenLengthPointer: number,
    ): WasiCall<number> => this.#noSys(),
    sock_shutdown: (_fd: number, _how: number): WasiCall<number> => this.#noSys(),
  };

  constructor(
    memory: WasiMemory,
    args: string[],
    env: string[],
    asyncMode: boolean,
    descriptors?: WasiDescriptorTable,
  ) {
    this.#memory = memory;
    this.#args = args;
    this.#env = env;
    this.#asyncMode = asyncMode;
    this.#poller = new WasiPoller(memory, asyncMode, descriptors, this.#clock);
  }

  *#argsSizesGet(countPointer: number, sizePointer: number): WasiCall<number> {
    const { count, size } = this.#memory.stringSizes(this.#args);
    const countView = this.#memory.view(countPointer, 4);
    const sizeView = this.#memory.view(sizePointer, 4);
    countView.setUint32(0, count, true);
    sizeView.setUint32(0, size, true);
    return ERRNO_SUCCESS;
  }

  *#argsGet(argsPointer: number, bufferPointer: number): WasiCall<number> {
    this.#memory.writeStrings(this.#args, argsPointer, bufferPointer);
    return ERRNO_SUCCESS;
  }

  *#environSizesGet(countPointer: number, sizePointer: number): WasiCall<number> {
    const { count, size } = this.#memory.stringSizes(this.#env);
    const countView = this.#memory.view(countPointer, 4);
    const sizeView = this.#memory.view(sizePointer, 4);
    countView.setUint32(0, count, true);
    sizeView.setUint32(0, size, true);
    return ERRNO_SUCCESS;
  }

  *#environGet(environPointer: number, bufferPointer: number): WasiCall<number> {
    this.#memory.writeStrings(this.#env, environPointer, bufferPointer);
    return ERRNO_SUCCESS;
  }

  *#clockResGet(clockId: number, resolutionPointer: number): WasiCall<number> {
    const resolution = this.#clock.resolution(clockId);
    if (resolution === undefined) return ERRNO_NOTSUP;
    this.#memory.u64(resolutionPointer, resolution);
    return ERRNO_SUCCESS;
  }

  *#clockTimeGet(clockId: number, _precision: bigint, timePointer: number): WasiCall<number> {
    const now = this.#clock.now(clockId);
    if (now === undefined) {
      return ERRNO_NOTSUP;
    }
    this.#memory.u64(timePointer, now);
    return ERRNO_SUCCESS;
  }

  *#randomGet(pointer: number, length: number): WasiCall<number> {
    const output = this.#memory.range(pointer, length);
    for (let offset = 0; offset < output.byteLength; offset += RANDOM_CHUNK_BYTES) {
      const end = Math.min(offset + RANDOM_CHUNK_BYTES, output.byteLength);
      crypto.getRandomValues(output.subarray(offset, end));
    }
    return ERRNO_SUCCESS;
  }

  *#schedYield(): WasiCall<number> {
    return yield* complete(this.#asyncMode ? Promise.resolve(ERRNO_SUCCESS) : ERRNO_SUCCESS);
  }

  *#exit(code: number): WasiCall<never> {
    throw new WasiExit(code);
  }

  #noSys(): WasiCall<number> {
    return complete(ERRNO_NOSYS);
  }

  *#pollOneoff(
    subscriptionsPointer: number,
    eventsPointer: number,
    count: number,
    eventsCountPointer: number,
  ): WasiCall<number> {
    return yield* this.#poller.pollOneoff(
      subscriptionsPointer,
      eventsPointer,
      count,
      eventsCountPointer,
    );
  }
}
