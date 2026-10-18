// @effect-diagnostics globalDate:off globalTimers:off - portable WASI host clocks run without Effect.
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

const NANOSECONDS_PER_MICROSECOND = 1_000n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_TIMER_NS = BigInt(MAX_TIMER_MS) * NANOSECONDS_PER_MILLISECOND;

/** Shared preview1 clock readings and bounded timer waits. */
export class WasiClock {
  resolution(clockId: number): bigint | undefined {
    switch (clockId >>> 0) {
      case 0:
        return NANOSECONDS_PER_MILLISECOND;
      case 1:
        return NANOSECONDS_PER_MICROSECOND;
      default:
        return undefined;
    }
  }

  now(clockId: number): bigint | undefined {
    switch (clockId >>> 0) {
      case 0:
        return BigInt(Date.now()) * NANOSECONDS_PER_MILLISECOND;
      case 1: {
        const milliseconds = Math.max(0, performance.now());
        const wholeMilliseconds = Math.floor(milliseconds);
        const subMillisecondNanoseconds = Math.floor(
          (milliseconds - wholeMilliseconds) * Number(NANOSECONDS_PER_MILLISECOND),
        );
        return (
          BigInt(wholeMilliseconds) * NANOSECONDS_PER_MILLISECOND +
          BigInt(subMillisecondNanoseconds)
        );
      }
      default:
        return undefined;
    }
  }

  wait(nanoseconds: bigint, signal: AbortSignal): Promise<void> {
    return waitForTimer(timerDelayMilliseconds(nanoseconds), signal);
  }
}

function timerDelayMilliseconds(nanoseconds: bigint): number {
  if (nanoseconds >= MAX_TIMER_NS) return MAX_TIMER_MS;
  const milliseconds = Number(
    (nanoseconds + NANOSECONDS_PER_MILLISECOND - 1n) / NANOSECONDS_PER_MILLISECOND,
  );
  return Math.max(1, milliseconds);
}

function waitForTimer(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("WASI poll was aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("WASI poll was aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
