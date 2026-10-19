import { describe, expect, it } from "@effect/vitest";

import { KernelCpuAccounting } from "./KernelCpuAccounting.ts";
import { KernelCpuExecution } from "./KernelCpuExecution.ts";

const makeClock = (initial = 0n) => {
  let now = initial;
  return {
    read: () => now,
    advance: (nanoseconds: bigint) => {
      now += nanoseconds;
    },
    set: (nanoseconds: bigint) => {
      now = nanoseconds;
    },
  };
};

describe("KernelCpuAccounting", () => {
  it("shares the clock with direct core scopes without double charging execution slices", () => {
    const clock = makeClock();
    const accounting = new KernelCpuAccounting(clock.read);
    const execution = new KernelCpuExecution(accounting);
    const direct = accounting.forProcess(2);
    execution.root.runUser(() => {
      clock.advance(2n);
      direct.runSystem(() => clock.advance(3n));
      clock.advance(5n);
      expect(execution.root.snapshot()).toEqual({ userNs: 7n, systemNs: 0n });
    });
    expect(execution.root.stop()).toEqual({ userNs: 7n, systemNs: 0n });
    expect(direct.snapshot()).toEqual({ userNs: 0n, systemNs: 3n });
    direct.dispose();
  });
  it("accounts exact user and system time through nested syscalls", () => {
    const clock = makeClock();
    const process = new KernelCpuAccounting(clock.read).forProcess(1);

    process.runUser(() => {
      clock.advance(3n);
      process.runSystem(() => {
        clock.advance(2n);
        process.runSystem(() => clock.advance(7n));
        clock.advance(11n);
      });
      clock.advance(13n);
    });

    expect(process.snapshot()).toEqual({ userNs: 16n, systemNs: 20n });
  });

  it("switches accounting between nested logical processes without cross attribution", () => {
    const clock = makeClock();
    const accounting = new KernelCpuAccounting(clock.read);
    const parent = accounting.forProcess(1);
    const child = accounting.forProcess(2);

    parent.runUser(() => {
      clock.advance(2n);
      child.runUser(() => {
        clock.advance(3n);
        child.runSystem(() => clock.advance(4n));
        clock.advance(1n);
      });
      clock.advance(2n);
    });

    expect(parent.snapshot()).toEqual({ userNs: 4n, systemNs: 0n });
    expect(child.snapshot()).toEqual({ userNs: 4n, systemNs: 4n });
  });

  it("settles explicit runnable slices and excludes the blocked gap before resuming", () => {
    const clock = makeClock();
    const process = new KernelCpuAccounting(clock.read).forProcess(1);

    const leaveFirstSlice = process.enterUser();
    clock.advance(4n);
    expect(process.snapshot()).toEqual({ userNs: 4n, systemNs: 0n });
    leaveFirstSlice();

    clock.advance(50_000n);
    expect(process.snapshot()).toEqual({ userNs: 4n, systemNs: 0n });

    const leaveResumedSlice = process.enterUser();
    clock.advance(3n);
    leaveResumedSlice();
    expect(process.snapshot()).toEqual({ userNs: 7n, systemNs: 0n });
  });

  it("includes a live interval in repeated snapshots without double counting", () => {
    const clock = makeClock();
    const process = new KernelCpuAccounting(clock.read).forProcess(1);

    const leave = process.enterSystem();
    clock.advance(5n);
    expect(process.snapshot()).toEqual({ userNs: 0n, systemNs: 5n });
    clock.advance(3n);
    expect(process.snapshot()).toEqual({ userNs: 0n, systemNs: 8n });
    leave();

    expect(process.snapshot()).toEqual({ userNs: 0n, systemNs: 8n });
  });

  it("keeps zero-resolution slices at zero", () => {
    const clock = makeClock();
    const process = new KernelCpuAccounting(clock.read).forProcess(1);

    process.runUser(() => {});
    process.runSystem(() => {});

    expect(process.snapshot()).toEqual({ userNs: 0n, systemNs: 0n });
  });

  it("cleans up a throwing nested syscall and resumes the parent user slice", () => {
    const clock = makeClock();
    const process = new KernelCpuAccounting(clock.read).forProcess(1);
    const leaveUser = process.enterUser();
    clock.advance(2n);

    expect(() =>
      process.runSystem(() => {
        clock.advance(3n);
        throw new Error("syscall failed");
      }),
    ).toThrow("syscall failed");

    clock.advance(4n);
    leaveUser();
    clock.advance(100n);

    expect(process.snapshot()).toEqual({ userNs: 6n, systemNs: 3n });
  });

  it("rejects Promise-like helper results after closing the synchronous slice", async () => {
    const clock = makeClock();
    const process = new KernelCpuAccounting(clock.read).forProcess(1);
    let finishWait: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      finishWait = resolve;
    });

    expect(() =>
      process.runUser(() => {
        clock.advance(2n);
        return waiting;
      }),
    ).toThrow("cannot wrap asynchronous work");
    expect(() => process.runSystem(() => Promise.reject(new Error("async failure")))).toThrow(
      "cannot wrap asynchronous work",
    );

    clock.advance(50_000n);
    finishWait?.();
    await Promise.resolve();
    expect(process.snapshot()).toEqual({ userNs: 2n, systemNs: 0n });
  });

  it("restores the shared scope stack when the host clock fails during leave", () => {
    let now = 0n;
    let failed = false;
    const process = new KernelCpuAccounting(() => {
      if (failed) throw new Error("clock failed");
      return now;
    }).forProcess(1);
    const leaveUser = process.enterUser();
    now = 2n;
    const leaveSystem = process.enterSystem();
    now = 5n;
    expect(process.snapshot()).toEqual({ userNs: 2n, systemNs: 3n });
    expect(process.dispose).toThrow("scope is open");

    failed = true;
    expect(leaveSystem).toThrow("clock failed");
    expect(leaveSystem).toThrow("already been left");
    failed = false;
    now = 9n;
    leaveUser();

    expect(process.snapshot()).toEqual({ userNs: 6n, systemNs: 3n });
    expect(process.dispose).not.toThrow();
  });

  it("clamps a regressing clock without decreasing cumulative snapshots", () => {
    const clock = makeClock(10n);
    const process = new KernelCpuAccounting(clock.read).forProcess(1);
    const leaveUser = process.enterUser();

    clock.set(12n);
    const activeSnapshot = process.snapshot();
    expect(activeSnapshot).toEqual({ userNs: 2n, systemNs: 0n });
    clock.set(9n);
    leaveUser();
    expect(process.snapshot()).toEqual(activeSnapshot);

    const leaveSystem = process.enterSystem();
    clock.set(16n);
    leaveSystem();
    expect(process.snapshot()).toEqual({ userNs: 2n, systemNs: 4n });
  });

  it("requires LIFO single-use leave tokens and releases inactive records", () => {
    const clock = makeClock();
    const accounting = new KernelCpuAccounting(clock.read);
    const parent = accounting.forProcess(1);
    const child = accounting.forProcess(2);
    const leaveParent = parent.enterUser();
    clock.advance(1n);
    const leaveChild = child.enterSystem();
    clock.advance(1n);

    expect(leaveParent).toThrow("reverse entry order");
    leaveChild();
    leaveParent();
    expect(() => leaveParent()).toThrow("already been left");
    expect(() => parent.dispose()).not.toThrow();
    expect(parent.snapshot).toThrow("disposed");
    expect(accounting.forProcess(1).snapshot()).toEqual({ userNs: 0n, systemNs: 0n });
    expect(child.snapshot()).toEqual({ userNs: 0n, systemNs: 1n });
  });
});
