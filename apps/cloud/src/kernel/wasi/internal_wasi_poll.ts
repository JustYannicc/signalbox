// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { complete, mapErrno, type WasiCall } from "./internal_wasi_calls.ts";
import {
  RIGHTS,
  type WasiDescriptor,
  type WasiDescriptorTable,
} from "./internal_wasi_descriptors.ts";
import { WasiClock } from "./internal_wasi_clock.ts";
import { WasiError, WasiMemory } from "./internal_wasi_memory.ts";

const ERRNO_SUCCESS = 0;
const ERRNO_EBADF = 8;
const ERRNO_INVAL = 28;
const ERRNO_NOTSUP = 58;
const ERRNO_NOTCAPABLE = 76;
const MAX_POLL_SUBSCRIPTIONS = 1024;
const MAX_UINT64 = (1n << 64n) - 1n;
const CLOCK_ABSTIME = 1;
const EVENT_CLOCK = 0;
const EVENT_FD_READ = 1;
const EVENT_FD_WRITE = 2;

interface PollEvent {
  readonly index: number;
  readonly userdata: bigint;
  readonly type: number;
  readonly errno: number;
  readonly bytes: bigint;
  readonly hangup: boolean;
}

interface ClockSubscription {
  readonly index: number;
  readonly userdata: bigint;
  readonly type: number;
  readonly clockId: number;
  readonly deadline: bigint;
}

interface FdSubscription {
  readonly index: number;
  readonly userdata: bigint;
  readonly type: number;
  readonly descriptor: WasiDescriptor;
}

interface PollSubscriptions {
  readonly immediate: PollEvent[];
  readonly clocks: ClockSubscription[];
  readonly fds: FdSubscription[];
}

interface ClockReadiness {
  readonly events: PollEvent[];
  readonly nextWait: bigint | undefined;
}

/** Implements preview1 poll_oneoff readiness over this host's descriptor table. */
export class WasiPoller {
  readonly #memory: WasiMemory;
  readonly #asyncMode: boolean;
  readonly #descriptors: WasiDescriptorTable | undefined;
  readonly #clock: WasiClock;

  constructor(
    memory: WasiMemory,
    asyncMode: boolean,
    descriptors: WasiDescriptorTable | undefined,
    clock: WasiClock,
  ) {
    this.#memory = memory;
    this.#asyncMode = asyncMode;
    this.#descriptors = descriptors;
    this.#clock = clock;
  }

  *pollOneoff(
    subscriptionsPointer: number,
    eventsPointer: number,
    count: number,
    eventsCountPointer: number,
  ): WasiCall<number> {
    const subscriptionCount = count >>> 0;
    if (subscriptionCount === 0 || subscriptionCount > MAX_POLL_SUBSCRIPTIONS) {
      return ERRNO_INVAL;
    }

    const subscriptionsSize = subscriptionCount * 48;
    const eventsSize = subscriptionCount * 32;
    this.#memory.range(subscriptionsPointer, subscriptionsSize);
    this.#memory.range(eventsPointer, eventsSize);
    this.#memory.range(eventsCountPointer, 4);

    const subscriptions = this.#readSubscriptions(subscriptionsPointer, subscriptionCount);
    let events: PollEvent[];
    if (this.#asyncMode) {
      const controller = new AbortController();
      try {
        events = yield* complete(this.#waitAsync(subscriptions, controller.signal));
      } finally {
        controller.abort();
      }
    } else {
      events = this.#pollSync(subscriptions);
    }

    // A suspended call may resume after WebAssembly memory has grown. Fetch
    // fresh views at the write boundary instead of retaining pre-wait views.
    this.#memory.range(eventsPointer, eventsSize);
    this.#memory.range(eventsCountPointer, 4);
    this.#writeEvents(eventsPointer, eventsCountPointer, events);
    return ERRNO_SUCCESS;
  }

  #readSubscriptions(pointer: number, count: number): PollSubscriptions {
    const input = this.#memory.bytes(pointer, count * 48);
    const table = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const immediate: PollEvent[] = [];
    const clocks: ClockSubscription[] = [];
    const fds: FdSubscription[] = [];

    for (let index = 0; index < count; index++) {
      const offset = index * 48;
      const userdata = BigInt.asUintN(64, table.getBigUint64(offset, true));
      const type = table.getUint8(offset + 8);
      if (type === EVENT_CLOCK) {
        const clockId = table.getUint32(offset + 16, true);
        const timeout = BigInt.asUintN(64, table.getBigUint64(offset + 24, true));
        const flags = table.getUint16(offset + 40, true);
        if ((flags & ~CLOCK_ABSTIME) !== 0) {
          immediate.push(this.#event(index, userdata, type, ERRNO_INVAL));
          continue;
        }
        const now = this.#clock.now(clockId);
        if (now === undefined) {
          immediate.push(this.#event(index, userdata, type, ERRNO_NOTSUP));
          continue;
        }
        clocks.push({
          index,
          userdata,
          type,
          clockId,
          deadline: flags & CLOCK_ABSTIME ? timeout : now + timeout,
        });
      } else if (type === EVENT_FD_READ || type === EVENT_FD_WRITE) {
        const fd = table.getUint32(offset + 16, true);
        if (this.#descriptors === undefined) {
          immediate.push(this.#event(index, userdata, type, ERRNO_NOTSUP));
          continue;
        }
        try {
          const descriptor = this.#descriptors.get(fd);
          this.#requirePollRights(descriptor, type);
          fds.push({ index, userdata, type, descriptor });
        } catch (error) {
          immediate.push(this.#event(index, userdata, type, mapErrno(error)));
        }
      } else {
        immediate.push(this.#event(index, userdata, type, ERRNO_INVAL));
      }
    }

    return { immediate, clocks, fds };
  }

  #requirePollRights(descriptor: WasiDescriptor, type: number): void {
    if ((descriptor.rightsBase & RIGHTS.POLL_FD_READWRITE) === 0n) {
      throw new WasiError(ERRNO_NOTCAPABLE);
    }
    const right = type === EVENT_FD_READ ? RIGHTS.FD_READ : RIGHTS.FD_WRITE;
    if ((descriptor.rightsBase & right) === 0n) {
      throw new WasiError(ERRNO_NOTCAPABLE);
    }
  }

  #pollSync(subscriptions: PollSubscriptions): PollEvent[] {
    const controller = new AbortController();
    const events = [...subscriptions.immediate];
    try {
      for (const subscription of subscriptions.fds) {
        try {
          const result = this.#readiness(subscription, controller.signal);
          if (isPromiseLike(result)) {
            consumeRejection(result);
            events.push(
              this.#event(
                subscription.index,
                subscription.userdata,
                subscription.type,
                ERRNO_NOTSUP,
              ),
            );
          } else {
            events.push(result);
          }
        } catch (error) {
          events.push(
            this.#event(
              subscription.index,
              subscription.userdata,
              subscription.type,
              mapErrno(error),
            ),
          );
        }
      }

      const clockReadiness = this.#clockReadiness(subscriptions.clocks);
      events.push(...clockReadiness.events);
      if (events.length === 0 && clockReadiness.nextWait !== undefined) {
        for (const clock of subscriptions.clocks) {
          if (this.#clock.now(clock.clockId) !== undefined) {
            events.push(this.#event(clock.index, clock.userdata, clock.type, ERRNO_NOTSUP));
          }
        }
      }
      return this.#sortEvents(events);
    } finally {
      controller.abort();
    }
  }

  async #waitAsync(subscriptions: PollSubscriptions, signal: AbortSignal): Promise<PollEvent[]> {
    const settled: PollEvent[] = [];
    const tasks: Promise<PollEvent>[] = [];
    let immediateFailure: unknown;
    let failed = false;

    // Invoke every provider before awaiting any of them. A synchronous throw
    // from one provider does not prevent the other subscriptions from starting.
    for (const subscription of subscriptions.fds) {
      try {
        const result = this.#readiness(subscription, signal);
        if (isPromiseLike(result)) {
          const task = Promise.resolve(result).then(
            (event) => {
              settled.push(event);
              return event;
            },
            (error: unknown) => {
              const event = this.#event(
                subscription.index,
                subscription.userdata,
                subscription.type,
                mapErrno(error),
              );
              settled.push(event);
              return event;
            },
          );
          void task.catch(() => undefined);
          tasks.push(task);
        } else {
          settled.push(result);
        }
      } catch (error) {
        try {
          settled.push(
            this.#event(
              subscription.index,
              subscription.userdata,
              subscription.type,
              mapErrno(error),
            ),
          );
        } catch (unexpected) {
          if (!failed) immediateFailure = unexpected;
          failed = true;
        }
      }
    }
    // Preserve unexpected provider values, including non-Error throws.
    if (failed) throw immediateFailure;

    const initialClocks = this.#clockReadiness(subscriptions.clocks);
    const initialEvents = this.#readyEvents(subscriptions.immediate, settled, initialClocks.events);
    if (initialEvents.length > 0) return initialEvents;

    for (;;) {
      if (signal.aborted) return [];
      const clocks = this.#clockReadiness(subscriptions.clocks);
      const events = this.#readyEvents(subscriptions.immediate, settled, clocks.events);
      if (events.length > 0) return events;

      if (tasks.length === 0 && clocks.nextWait === undefined) return [];

      const timer =
        clocks.nextWait === undefined ? undefined : this.#clock.wait(clocks.nextWait, signal);
      const winner = await Promise.race([
        ...tasks,
        ...(timer === undefined ? [] : [timer.then(() => undefined as PollEvent | undefined)]),
      ]);
      if (winner !== undefined) {
        return this.#readyEvents(
          subscriptions.immediate,
          settled,
          this.#clockReadiness(subscriptions.clocks).events,
        );
      }
    }
  }

  #readiness(subscription: FdSubscription, signal: AbortSignal): PollEvent | Promise<PollEvent> {
    const { descriptor, index, userdata, type } = subscription;
    if (descriptor.kind === "stdio") {
      const stdio = descriptor.stdio;
      const poll = stdio?.poll;
      if (poll === undefined) {
        return this.#event(index, userdata, type, ERRNO_NOTSUP);
      }
      const result = poll.call(stdio, type === EVENT_FD_READ ? "read" : "write", signal);
      if (isPromiseLike(result)) {
        if (!this.#asyncMode) {
          consumeRejection(result);
          return this.#event(index, userdata, type, ERRNO_NOTSUP);
        }
        return Promise.resolve(result).then((value) =>
          this.#stdioEvent(index, userdata, type, value),
        );
      }
      return this.#stdioEvent(index, userdata, type, result);
    }

    if (descriptor.kind !== "file") {
      return this.#event(index, userdata, type, ERRNO_NOTSUP);
    }

    const mount = descriptor.mount;
    const inode = descriptor.inode;
    if (mount === undefined || inode === undefined) {
      throw new WasiError(ERRNO_EBADF);
    }
    const stat = mount.storage.stat(inode);
    if (isPromiseLike(stat)) {
      if (!this.#asyncMode) {
        consumeRejection(stat);
        return this.#event(index, userdata, type, ERRNO_NOTSUP);
      }
      return Promise.resolve(stat).then((value) =>
        this.#fileEvent(index, userdata, type, descriptor, value.type, value.size),
      );
    }
    return this.#fileEvent(index, userdata, type, descriptor, stat.type, stat.size);
  }

  #stdioEvent(index: number, userdata: bigint, type: number, result: unknown): PollEvent {
    if (
      typeof result !== "object" ||
      result === null ||
      !("bytes" in result) ||
      typeof result.bytes !== "bigint" ||
      result.bytes < 0n ||
      result.bytes > MAX_UINT64 ||
      ("hangup" in result && result.hangup !== undefined && typeof result.hangup !== "boolean")
    ) {
      throw new WasiError(ERRNO_INVAL);
    }
    return this.#event(
      index,
      userdata,
      type,
      ERRNO_SUCCESS,
      result.bytes,
      "hangup" in result && result.hangup === true,
    );
  }

  #fileEvent(
    index: number,
    userdata: bigint,
    type: number,
    descriptor: WasiDescriptor,
    fileType: string,
    size: bigint,
  ): PollEvent {
    if (fileType !== "file") {
      return this.#event(index, userdata, type, ERRNO_NOTSUP);
    }
    const bytes =
      type === EVENT_FD_READ ? (size > descriptor.offset ? size - descriptor.offset : 0n) : 0n;
    return this.#event(index, userdata, type, ERRNO_SUCCESS, bytes);
  }

  #clockReadiness(clocks: ClockSubscription[]): ClockReadiness {
    const events: PollEvent[] = [];
    let nextWait: bigint | undefined;
    for (const clock of clocks) {
      const now = this.#clock.now(clock.clockId);
      if (now === undefined) {
        events.push(this.#event(clock.index, clock.userdata, clock.type, ERRNO_NOTSUP));
      } else if (now >= clock.deadline) {
        events.push(this.#event(clock.index, clock.userdata, clock.type, ERRNO_SUCCESS));
      } else {
        const remaining = clock.deadline - now;
        if (nextWait === undefined || remaining < nextWait) {
          nextWait = remaining;
        }
      }
    }
    return { events, nextWait };
  }

  #readyEvents(immediate: PollEvent[], settled: PollEvent[], clocks: PollEvent[]): PollEvent[] {
    return this.#sortEvents([...immediate, ...settled, ...clocks]);
  }

  #event(
    index: number,
    userdata: bigint,
    type: number,
    errno: number,
    bytes = 0n,
    hangup = false,
  ): PollEvent {
    return { index, userdata, type, errno, bytes, hangup };
  }

  #sortEvents(events: PollEvent[]): PollEvent[] {
    return events.sort((left, right) => left.index - right.index);
  }

  #writeEvents(pointer: number, countPointer: number, events: PollEvent[]): void {
    const output = this.#memory.range(pointer, events.length * 32);
    output.fill(0);
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    for (const [index, event] of events.entries()) {
      const offset = index * 32;
      view.setBigUint64(offset, BigInt.asUintN(64, event.userdata), true);
      view.setUint16(offset + 8, event.errno, true);
      view.setUint8(offset + 10, event.type);
      view.setBigUint64(offset + 16, event.bytes, true);
      view.setUint16(offset + 24, event.hangup ? 1 : 0, true);
    }
    this.#memory.u32(countPointer, events.length);
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

function consumeRejection(value: PromiseLike<unknown>): void {
  void Promise.resolve(value).catch(() => undefined);
}
