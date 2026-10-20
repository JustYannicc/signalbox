import { FDFLAGS } from "../wasi/internal_wasi_descriptors.ts";
import { WasiClock } from "../wasi/internal_wasi_clock.ts";
import type { HttpSocket } from "./HttpSocket.ts";
import { errno, fail, NET_ERRNO, range, u32, writeU32 } from "./Memory.ts";
import type { KernelHttpNetworkHostOptions } from "./Types.ts";

export function receiveHttp(
  options: KernelHttpNetworkHostOptions,
  resource: (fd: number) => HttpSocket,
  args: readonly number[],
  blocking: false,
): number;
export function receiveHttp(
  options: KernelHttpNetworkHostOptions,
  resource: (fd: number) => HttpSocket,
  args: readonly number[],
  blocking: true,
): number | Promise<number>;
export function receiveHttp(
  options: KernelHttpNetworkHostOptions,
  resource: (fd: number) => HttpSocket,
  args: readonly number[],
  blocking: boolean,
): number | Promise<number> {
  const [fd, buffer, length, flags, outReceived] = args as [number, number, number, number, number];
  const memory = options.memory();
  range(memory, outReceived, 4);
  range(memory, buffer, length);
  if (flags !== 0) fail(NET_ERRNO.NOTSUP);
  const socket = resource(fd);
  const attempt = () => {
    // JSPI may resume after memory growth, fd reuse, or host cancellation.
    if (options.memory() !== memory) fail(NET_ERRNO.FAULT);
    range(memory, outReceived, 4);
    const offset = range(memory, buffer, length);
    if (resource(fd) !== socket) fail(NET_ERRNO.BADF);
    writeU32(memory, outReceived, 0);
    const count = socket.read(new Uint8Array(memory.buffer, offset, u32(length)));
    writeU32(memory, outReceived, count);
    return 0;
  };
  try {
    return attempt();
  } catch (error) {
    if (!blocking || errno(error) !== NET_ERRNO.AGAIN || nonblocking(options, fd)) throw error;
  }
  const deadline = socket.recvTimeoutMs === null ? null : performance.now() + socket.recvTimeoutMs;
  return (async () => {
    try {
      for (;;) {
        await waitReadable(options, socket, deadline);
        try {
          return attempt();
        } catch (error) {
          if (
            errno(error) !== NET_ERRNO.AGAIN ||
            nonblocking(options, fd) ||
            (deadline !== null && performance.now() >= deadline)
          )
            throw error;
        }
      }
    } catch (error) {
      return errno(error);
    }
  })();
}

function nonblocking(options: KernelHttpNetworkHostOptions, fd: number): boolean {
  return (options.descriptors.table.get(u32(fd)).flags & FDFLAGS.NONBLOCK) !== 0;
}

async function waitReadable(
  options: KernelHttpNetworkHostOptions,
  socket: HttpSocket,
  deadline: number | null,
): Promise<void> {
  const wakes = options.descriptors.wakes;
  const registration = wakes.register((notify) => socket.subscribe("read", notify));
  if (registration.status !== "ok") fail(NET_ERRNO.IO);
  const token = registration.value;
  const timerAbort = new AbortController();
  let timer: Promise<void> | undefined;
  try {
    if (socket.ready("read") !== undefined) wakes.signal(token);
    const pending = wakes.wait(token, options.signal);
    if (deadline !== null) {
      const remaining = BigInt(Math.max(0, Math.ceil((deadline - performance.now()) * 1_000_000)));
      timer = new WasiClock().wait(remaining, timerAbort.signal).then(
        () => {
          wakes.signal(token);
        },
        () => undefined,
      );
    }
    const result = await pending;
    if (result.status !== "ok" && result.error.code !== "EXPIRED") fail(NET_ERRNO.CANCELED);
  } finally {
    timerAbort.abort();
    wakes.release(token);
    await timer;
  }
}
