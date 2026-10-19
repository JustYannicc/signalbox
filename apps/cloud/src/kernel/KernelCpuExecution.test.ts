import { describe, expect, it } from "@effect/vitest";

import { KernelCpuAccounting } from "./KernelCpuAccounting.ts";
import {
  KernelCpuExecution,
  captureKernelCpuExecution,
  runCurrentKernelCpuAsyncSystemImport,
  runCurrentKernelCpuAwaitableSystemImport,
  runCurrentKernelCpuSystemImport,
} from "./KernelCpuExecution.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

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
  it.each([false, true])(
    "accounts same-turn sibling imports with measured=%s clock resolution",
    async (measured) => {
      const clock = makeClock();
      const execution = new KernelCpuExecution(new KernelCpuAccounting(clock.read));
      const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const processes = [execution.forProcess(2), execution.forProcess(3)];
      const advance = (value: number) => clock.advance(measured ? BigInt(value) : 0n);
      const completions = processes.map((process, index) =>
        process.run(() => {
          const leave = process.enterUser();
          advance(index + 1);
          // Match the extra async wrapper at the WASI import boundary.
          const imported = async () =>
            await runCurrentKernelCpuAsyncSystemImport(async (runSystem) => {
              runSystem(() => advance(index + 3));
              await gates[index]!.promise;
              runSystem(() => advance(index + 5));
            });
          return imported()
            .then(() => {
              advance(index + 7);
              process.runSystem(() => advance(index + 11));
            })
            .finally(leave);
        }),
      );
      clock.advance(100_000n);
      for (const gate of gates) gate.resolve();
      const results = await Promise.allSettled(completions);
      expect(results).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      for (const [index, process] of processes.entries()) {
        expect(process.stop()).toEqual({
          userNs: measured ? BigInt(2 * index + 8) : 0n,
          systemNs: measured ? BigInt(3 * index + 19) : 0n,
        });
      }
    },
  );

  it.each([false, true])(
    "accounts same-turn sibling wakes with measured=%s clock resolution",
    async (measured) => {
      const clock = makeClock();
      const execution = new KernelCpuExecution(new KernelCpuAccounting(clock.read));
      const wakes = new KernelWakeRegistry();
      const processes = [execution.forProcess(2), execution.forProcess(3)];
      const tokens = processes.map(() => {
        const registered = wakes.register(() => () => {});
        if (registered.status !== "ok") throw new Error("Wake registration failed");
        return registered.value;
      });
      const completions = processes.map((process, index) =>
        process.run(() => {
          const leave = process.enterUser();
          clock.advance(measured ? BigInt(index + 1) : 0n);
          return wakes.wait(tokens[index]!).then((result) => {
            expect(result.status).toBe("ok");
            clock.advance(measured ? BigInt(index + 3) : 0n);
            process.runSystem(() => clock.advance(measured ? BigInt(index + 5) : 0n));
            leave();
          });
        }),
      );
      clock.advance(100_000n);
      for (const token of tokens) wakes.signal(token);
      expect(await Promise.allSettled(completions)).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(wakes.size).toBe(0);
      for (const [index, process] of processes.entries()) {
        expect(process.stop()).toEqual({
          userNs: measured ? BigInt(2 * index + 4) : 0n,
          systemNs: measured ? BigInt(index + 5) : 0n,
        });
      }
      wakes.dispose();
    },
  );

  it("consumes a failed nested leave and restores its parent", () => {
    let failed = false;
    const failure = new Error("clock failed");
    const clock = makeClock();
    const execution = new KernelCpuExecution(
      new KernelCpuAccounting(() => {
        if (failed) throw failure;
        return clock.read();
      }),
    );
    execution.root.run(() => {
      const leaveUser = execution.root.enterUser();
      clock.advance(2n);
      const leaveSystem = execution.root.enterSystem();
      failed = true;
      expect(leaveSystem).toThrow(failure);
      failed = false;
      expect(leaveSystem).toThrow("already been left");
      execution.root.runSystem(() => clock.advance(3n));
      clock.advance(5n);
      leaveUser();
    });
    expect(execution.root.stop()).toEqual({ userNs: 7n, systemNs: 3n });
  });

  it("rolls back failed entries and clears a consumed pause", () => {
    let failed = false;
    const failure = new Error("clock failed");
    const clock = makeClock();
    const execution = new KernelCpuExecution(
      new KernelCpuAccounting(() => {
        if (failed) throw failure;
        return clock.read();
      }),
    );
    execution.root.run(() => {
      failed = true;
      expect(() => execution.root.enterUser()).toThrow(failure);
      failed = false;
      const leave = execution.root.enterUser();
      failed = true;
      expect(() => execution.root.enterSystem()).toThrow(failure);
      failed = false;
      execution.root.runSystem(() => clock.advance(3n));
      const captured = captureKernelCpuExecution();
      failed = true;
      expect(() => captured?.pause()).toThrow(failure);
      failed = false;
      execution.root.runSystem(() => clock.advance(5n));
      clock.advance(7n);
      leave();
    });
    expect(execution.root.stop()).toEqual({ userNs: 7n, systemNs: 8n });
  });

  it("keeps the root lifetime open after launch returns until its observation completes", async () => {
    const clock = makeClock();
    const accounting = new KernelCpuAccounting(clock.read);
    const execution = new KernelCpuExecution(accounting);
    const wakes = new KernelWakeRegistry();
    const registered = wakes.register(() => () => {});
    if (registered.status !== "ok") throw new Error("Wake registration failed");
    const launched = execution.root.run(() => {
      const leave = execution.root.enterUser();
      clock.advance(2n);
      return {
        done: wakes.wait(registered.value).then(() => {
          clock.advance(3n);
          expect(accounting.forProcess(1).snapshot()).toEqual({ userNs: 5n, systemNs: 0n });
          leave();
        }),
      };
    });
    expect(() => execution.root.stop()).toThrow("scope is open");
    clock.advance(100_000n);
    const child = execution.forProcess(2);
    child.runUser(() => clock.advance(7n));
    wakes.signal(registered.value);
    await launched.done;
    expect(execution.root.stop()).toEqual({ userNs: 5n, systemNs: 0n });
    expect(child.stop()).toEqual({ userNs: 7n, systemNs: 0n });
    wakes.dispose();
  });

  it.each(["sync", "async", "awaitable"] as const)(
    "restores the user frame when %s import entry fails",
    async (importKind) => {
      let now = 0n;
      let reads = 0;
      let failed = false;
      const failures: Error[] = [];
      const execution = new KernelCpuExecution(
        new KernelCpuAccounting(() => {
          reads++;
          if (failed && reads >= 3) {
            const error = new Error(`clock failure ${failures.length + 1}`);
            failures.push(error);
            throw error;
          }
          return now;
        }),
      );
      await execution.root.run(async () => {
        const leave = execution.root.enterUser();
        now += 2n;
        failed = true;
        const run = () => {
          throw new Error("Failed entry must not invoke the import");
        };
        if (importKind === "sync") {
          expect(() => runCurrentKernelCpuSystemImport(run)).toThrow("clock failure 1");
        } else {
          const imported =
            importKind === "async"
              ? runCurrentKernelCpuAsyncSystemImport(run)
              : runCurrentKernelCpuAwaitableSystemImport(run);
          await expect(imported).rejects.toBe(failures[0]);
        }
        expect(failures).toHaveLength(1);
        failed = false;
        now += 3n;
        execution.root.runSystem(() => {
          now += 5n;
        });
        leave();
      });
      expect(execution.root.stop()).toEqual({ userNs: 5n, systemNs: 5n });
    },
  );

  it("keeps logical LIFO guards while restoring nested PID and mode attribution", () => {
    const clock = makeClock();
    const execution = new KernelCpuExecution(new KernelCpuAccounting(clock.read));
    const child = execution.forProcess(2);
    execution.root.run(() => {
      const leaveUser = execution.root.enterUser();
      clock.advance(2n);
      const leaveSystem = execution.root.enterSystem();
      expect(leaveUser).toThrow("reverse entry order");
      clock.advance(3n);
      child.runUser(() => {
        clock.advance(5n);
        child.runSystem(() => clock.advance(7n));
      });
      clock.advance(11n);
      leaveSystem();
      clock.advance(13n);
      leaveUser();
    });
    expect(execution.root.stop()).toEqual({ userNs: 15n, systemNs: 14n });
    expect(child.stop()).toEqual({ userNs: 5n, systemNs: 7n });
  });
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
      return runCurrentKernelCpuAsyncSystemImport(async (runSystem) => {
        runSystem(() => clock.advance(3n));
        await io;
        runSystem(() => clock.advance(5n));
        return 42;
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
