import { describe, expect, it } from "@effect/vitest";

import { KernelCpuAccounting } from "./KernelCpuAccounting.ts";
import {
  KernelCpuExecution,
  runCurrentKernelCpuAsyncSystemImport,
  runCurrentKernelCpuSystemImport,
} from "./KernelCpuExecution.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { runAsync } from "./wasi/internal_wasi_calls.ts";

const makeClock = () => {
  let now = 0n;
  return {
    read: () => now,
    advance: (nanoseconds: bigint) => {
      now += nanoseconds;
    },
  };
};

describe("KernelCpuExecution", () => {
  it("switches nested process work and system imports without cross-attribution", () => {
    const clock = makeClock();
    const execution = new KernelCpuExecution(new KernelCpuAccounting(clock.read));
    const root = execution.root;
    const child = execution.forProcess(2);

    root.runUser(() => {
      clock.advance(2n);
      runCurrentKernelCpuSystemImport(() => clock.advance(5n));
      child.runUser(() => {
        clock.advance(3n);
        child.runSystem(() => clock.advance(7n));
      });
      clock.advance(11n);
    });

    expect(root.snapshot()).toEqual({ userNs: 13n, systemNs: 5n });
    expect(child.snapshot()).toEqual({ userNs: 3n, systemNs: 7n });
  });

  it("retains root identity through detached promises without charging the wait", async () => {
    const clock = makeClock();
    const execution = new KernelCpuExecution(new KernelCpuAccounting(clock.read));
    const root = execution.root;
    let finish: (() => void) | undefined;

    const detached = root.run(() => {
      root.runUser(() => clock.advance(2n));
      return new Promise<void>((resolve) => {
        finish = resolve;
      }).then(() => {
        expect(execution.current()).toBe(root);
        root.runUser(() => clock.advance(5n));
      });
    });

    clock.advance(100_000n);
    finish?.();
    await detached;

    expect(root.snapshot()).toEqual({ userNs: 7n, systemNs: 0n });
    expect(root.stop()).toEqual({ userNs: 7n, systemNs: 0n });
  });

  it("pauses the waiting owner until a wake callback has unwound", async () => {
    const clock = makeClock();
    const execution = new KernelCpuExecution(new KernelCpuAccounting(clock.read));
    const root = execution.root;
    const child = execution.forProcess(2);
    const wakes = new KernelWakeRegistry();
    const registration = wakes.register(() => () => {});
    if (registration.status !== "ok") throw new Error("Wake registration failed");

    const waiting = root.run(() => {
      const leaveUser = root.enterUser();
      clock.advance(3n);
      return wakes.wait(registration.value).then((result) => {
        expect(execution.current()).toBe(root);
        clock.advance(2n);
        leaveUser();
        return result;
      });
    });

    clock.advance(500_000n);
    child.runUser(() => {
      clock.advance(7n);
      wakes.signal(registration.value);
      clock.advance(11n);
    });
    await waiting;

    expect(root.snapshot()).toEqual({ userNs: 5n, systemNs: 0n });
    expect(child.snapshot()).toEqual({ userNs: 18n, systemNs: 0n });
    wakes.dispose();
  });

  it("counts async syscall steps while excluding the suspended I/O wait", async () => {
    const clock = makeClock();
    const execution = new KernelCpuExecution(new KernelCpuAccounting(clock.read));
    const root = execution.root;
    let finishIo!: (value: number) => void;
    const io = new Promise<number>((resolve) => {
      finishIo = resolve;
    });

    const result = root.run(() => {
      const leaveUser = root.enterUser();
      return runCurrentKernelCpuAsyncSystemImport((runSystem) => {
        const call = (function* (): Generator<unknown, number, unknown> {
          runSystem(() => clock.advance(3n));
          yield io;
          runSystem(() => clock.advance(5n));
          return 42;
        })();
        return runAsync(call, runSystem);
      })
        .then((value) => {
          expect(value).toBe(42);
          clock.advance(7n);
        })
        .finally(leaveUser);
    });

    clock.advance(100_000n);
    finishIo(42);
    await result;

    expect(root.snapshot()).toEqual({ userNs: 7n, systemNs: 8n });
  });

  it("leaves a user scope closed when its synchronous slice throws", () => {
    const clock = makeClock();
    const execution = new KernelCpuExecution(new KernelCpuAccounting(clock.read));
    const process = execution.forProcess(2);
    const failure = new Error("user slice failed");

    expect(() =>
      process.run(() =>
        process.runUser(() => {
          clock.advance(4n);
          throw failure;
        }),
      ),
    ).toThrow(failure);
    expect(process.stop()).toEqual({ userNs: 4n, systemNs: 0n });
    expect(() => process.runUser(() => undefined)).toThrow("CPU process execution is stopped");
  });
});
