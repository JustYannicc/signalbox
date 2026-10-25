import { describe, expect, it, vi } from "vite-plus/test";
import { kernelError, type KernelResult } from "./KernelAbi.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import {
  KernelProcessTable,
  type KernelExitStatus,
  type KernelSignalMask,
} from "./KernelProcessTable.ts";

const exited: KernelExitStatus = { exitCode: 0, signal: 0, coreDumped: false };
const emptyMask: KernelSignalMask = { low: 0, high: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeTable() {
  const wakes = new KernelWakeRegistry();
  return { table: new KernelProcessTable({ wakes }), wakes };
}

function child(
  completion: Promise<KernelExitStatus>,
  signal: (number: number) => KernelResult<void> = () => ({ status: "ok", value: undefined }),
  supportedSignals?: readonly number[],
) {
  return {
    completion,
    signal,
    ...(supportedSignals === undefined ? {} : { supportedSignals }),
  };
}

describe("KernelProcessTable signal masks", () => {
  it("keeps root, child, and grandchild masks independent while inheriting only the mask", async () => {
    const { table } = makeTable();
    const childCompletion = deferred<KernelExitStatus>();
    const grandchildCompletion = deferred<KernelExitStatus>();
    const explicitCompletion = deferred<KernelExitStatus>();
    const childSignal = vi.fn((_number: number) => ({ status: "ok" as const, value: undefined }));
    const grandchildSignal = vi.fn((_number: number) => ({
      status: "ok" as const,
      value: undefined,
    }));
    const explicitSignal = vi.fn((_number: number) => ({
      status: "ok" as const,
      value: undefined,
    }));
    const rootMask = { low: 0x8000_0000, high: 0x8000_0001 };
    const childMask = { low: 0x8000_4000, high: 0x8000_0001 };

    expect(table.signalMask(undefined, 2, rootMask)).toEqual({ status: "ok", value: emptyMask });
    const spawnedChild = table.spawn(
      undefined,
      (identity) => {
        expect(table.signalMask(identity.handle, 3)).toEqual({ status: "ok", value: rootMask });
        return child(childCompletion.promise, childSignal);
      },
      vi.fn(),
    );
    expect(spawnedChild.status).toBe("ok");
    if (spawnedChild.status !== "ok") return;

    expect(table.signalMask(spawnedChild.value.handle, 0, { low: 0x4000, high: 0 })).toEqual({
      status: "ok",
      value: rootMask,
    });
    expect(table.signal(spawnedChild.value.handle, 15)).toEqual({
      status: "ok",
      value: undefined,
    });
    expect(table.signal(spawnedChild.value.handle, 15)).toEqual({
      status: "ok",
      value: undefined,
    });
    expect(childSignal).not.toHaveBeenCalled();

    const spawnedGrandchild = table.spawn(
      spawnedChild.value.handle,
      (identity) => {
        expect(table.signalMask(identity.handle, 3)).toEqual({ status: "ok", value: childMask });
        return child(grandchildCompletion.promise, grandchildSignal);
      },
      vi.fn(),
    );
    expect(spawnedGrandchild.status).toBe("ok");
    if (spawnedGrandchild.status !== "ok") return;

    // The grandchild inherits the mask, not the parent's already-pending SIGTERM.
    expect(table.signalMask(spawnedGrandchild.value.handle, 1, { low: 0x4000, high: 0 })).toEqual({
      status: "ok",
      value: childMask,
    });
    expect(grandchildSignal).not.toHaveBeenCalled();

    expect(table.signalMask(spawnedGrandchild.value.handle, 2, { low: 0, high: 1 })).toEqual({
      status: "ok",
      value: { low: 0x8000_0000, high: 0x8000_0001 },
    });

    // SIG32, SIG33, and SIG64 exercise the low/high word boundary and bit 63.
    for (const signal of [32, 33, 64]) {
      expect(table.signal(spawnedGrandchild.value.handle, signal)).toEqual({
        status: "ok",
        value: undefined,
      });
    }
    expect(grandchildSignal.mock.calls.map(([signal]) => signal)).toEqual([32, 64]);
    expect(table.signalMask(spawnedGrandchild.value.handle, 1, { low: 0, high: 1 })).toEqual({
      status: "ok",
      value: { low: 0, high: 1 },
    });
    expect(grandchildSignal.mock.calls.map(([signal]) => signal)).toEqual([32, 64, 33]);

    expect(table.signalMask(spawnedGrandchild.value.handle, 2, emptyMask)).toEqual({
      status: "ok",
      value: { low: 0, high: 0 },
    });
    expect(table.signalMask(spawnedGrandchild.value.handle, 3)).toEqual({
      status: "ok",
      value: emptyMask,
    });
    expect(table.signalMask(spawnedChild.value.handle, 3)).toEqual({
      status: "ok",
      value: childMask,
    });
    expect(table.signalMask(undefined, 3)).toEqual({ status: "ok", value: rootMask });

    const explicitMask = { low: 0, high: 0x8000_0000 };
    const explicitChild = table.spawn(
      spawnedChild.value.handle,
      (identity) => {
        expect(table.signalMask(identity.handle, 3)).toEqual({
          status: "ok",
          value: explicitMask,
        });
        return child(explicitCompletion.promise, explicitSignal);
      },
      vi.fn(),
      { signalMask: explicitMask },
    );
    expect(explicitChild.status).toBe("ok");
    if (explicitChild.status === "ok") {
      expect(table.signalMask(explicitChild.value.handle, 3)).toEqual({
        status: "ok",
        value: explicitMask,
      });
    }

    childCompletion.resolve(exited);
    grandchildCompletion.resolve(exited);
    explicitCompletion.resolve(exited);
    expect(await table.dispose()).toEqual({ status: "ok", value: undefined });
  });

  it("coalesces blocked signals, strips SIGKILL and SIGSTOP, and rejects unsupported signals", async () => {
    const { table } = makeTable();
    const completion = deferred<KernelExitStatus>();
    const signal = vi.fn((_number: number) => ({ status: "ok" as const, value: undefined }));
    const spawned = table.spawn(undefined, () => child(completion.promise, signal), vi.fn());
    expect(spawned.status).toBe("ok");
    if (spawned.status !== "ok") return;

    expect(
      table.signalMask(spawned.value.handle, 0, {
        low: 0x0004_4100, // SIG9, SIG15, and SIG19
        high: 0,
      }),
    ).toEqual({ status: "ok", value: emptyMask });
    expect(table.signalMask(spawned.value.handle, 3)).toEqual({
      status: "ok",
      value: { low: 0x0000_4000, high: 0 },
    });

    expect(table.signal(spawned.value.handle, 15)).toEqual({ status: "ok", value: undefined });
    expect(table.signal(spawned.value.handle, 15)).toEqual({ status: "ok", value: undefined });
    expect(signal).not.toHaveBeenCalled();
    expect(table.signal(spawned.value.handle, 9)).toEqual({ status: "ok", value: undefined });
    expect(table.signal(spawned.value.handle, 19)).toEqual({ status: "ok", value: undefined });
    expect(signal.mock.calls.map(([number]) => number)).toEqual([9, 19]);

    expect(table.signalMask(spawned.value.handle, 1, { low: 0x4000, high: 0 })).toEqual({
      status: "ok",
      value: { low: 0x4000, high: 0 },
    });
    expect(signal.mock.calls.map(([number]) => number)).toEqual([9, 19, 15]);

    const unsupportedCompletion = deferred<KernelExitStatus>();
    const unsupportedSignal = vi.fn((_number: number) => ({
      status: "ok" as const,
      value: undefined,
    }));
    const limitedChild = table.spawn(
      undefined,
      () => child(unsupportedCompletion.promise, unsupportedSignal, [9, 15]),
      vi.fn(),
    );
    expect(limitedChild.status).toBe("ok");
    if (limitedChild.status !== "ok") return;

    expect(table.signalMask(limitedChild.value.handle, 0, { low: 0x800, high: 0 })).toEqual({
      status: "ok",
      value: emptyMask,
    });
    expect(table.signal(limitedChild.value.handle, 12)).toMatchObject({
      status: "error",
      error: { code: "UNSUPPORTED" },
    });
    expect(table.signalMask(limitedChild.value.handle, 1, { low: 0x800, high: 0 })).toEqual({
      status: "ok",
      value: { low: 0x800, high: 0 },
    });
    expect(unsupportedSignal).not.toHaveBeenCalled();

    completion.resolve(exited);
    unsupportedCompletion.resolve(exited);
    expect(await table.dispose()).toEqual({ status: "ok", value: undefined });
  });

  it("rejects invalid mask requests and handles without mutating stored masks", async () => {
    const { table } = makeTable();
    const completion = deferred<KernelExitStatus>();
    const signal = vi.fn((_number: number) => ({ status: "ok" as const, value: undefined }));
    const spawned = table.spawn(undefined, () => child(completion.promise, signal), vi.fn());
    expect(spawned.status).toBe("ok");
    if (spawned.status !== "ok") return;

    const originalMask = { low: 0x4001, high: 2 };
    expect(table.signalMask(spawned.value.handle, 2, originalMask)).toEqual({
      status: "ok",
      value: emptyMask,
    });
    expect(table.signal(spawned.value.handle, 15)).toEqual({ status: "ok", value: undefined });
    expect(table.signalMask(spawned.value.handle, 4)).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(table.signalMask(spawned.value.handle, 0, { low: -1, high: 0 })).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(
      table.signalMask(spawned.value.handle, 2, { low: 0, high: 0x1_0000_0000 }),
    ).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
    expect(table.signalMask({ id: "foreign", kind: "process" }, 3)).toMatchObject({
      status: "error",
      error: { code: "INVALID_HANDLE" },
    });
    expect(signal).not.toHaveBeenCalled();
    expect(table.signalMask(spawned.value.handle, 3)).toEqual({
      status: "ok",
      value: originalMask,
    });
    expect(table.signalMask(spawned.value.handle, 1, { low: 0x4000, high: 0 })).toEqual({
      status: "ok",
      value: originalMask,
    });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(table.signalMask(undefined, 4)).toMatchObject({
      status: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(table.signalMask(undefined, 3)).toEqual({ status: "ok", value: emptyMask });

    completion.resolve(exited);
    expect(await table.dispose()).toEqual({ status: "ok", value: undefined });
    expect(table.signalMask(undefined, 3)).toMatchObject({
      status: "error",
      error: { code: "CANCELLED" },
    });
  });

  it("retains failed pending delivery, keeps queries inert, and deduplicates reentrant signals", async () => {
    const { table } = makeTable();
    const completion = deferred<KernelExitStatus>();
    let handle: { readonly id: string; readonly kind: "process" } | undefined;
    let attempts = 0;
    const signal = vi.fn((number: number): KernelResult<void> => {
      attempts++;
      if (attempts === 1) {
        expect(number).toBe(15);
        expect(table.signalMask(handle, 0, { low: 0x4000, high: 0 })).toEqual({
          status: "ok",
          value: emptyMask,
        });
        expect(table.signal(handle!, 15)).toEqual({ status: "ok", value: undefined });
        return kernelError("IO_ERROR", "runner refused signal");
      }
      return { status: "ok", value: undefined };
    });
    const spawned = table.spawn(undefined, () => child(completion.promise, signal), vi.fn());
    expect(spawned.status).toBe("ok");
    if (spawned.status !== "ok") return;
    handle = spawned.value.handle;

    expect(table.signalMask(handle, 0, { low: 0x4000, high: 0 })).toEqual({
      status: "ok",
      value: emptyMask,
    });
    expect(table.signal(handle, 15)).toEqual({ status: "ok", value: undefined });
    expect(table.signalMask(handle, 1, { low: 0x4000, high: 0 })).toMatchObject({
      status: "error",
      error: { code: "IO_ERROR" },
    });
    expect(signal).toHaveBeenCalledTimes(1);

    // Querying returns the committed mask and must not retry the failed pending signal.
    expect(table.signalMask(handle, 3)).toEqual({
      status: "ok",
      value: { low: 0x4000, high: 0 },
    });
    expect(signal).toHaveBeenCalledTimes(1);

    // The callback reblocked and requeued SIGTERM before failing; one later unblock retries it once.
    expect(table.signalMask(handle, 1, { low: 0x4000, high: 0 })).toEqual({
      status: "ok",
      value: { low: 0x4000, high: 0 },
    });
    expect(signal.mock.calls.map(([number]) => number)).toEqual([15, 15]);

    completion.resolve(exited);
    expect(await table.dispose()).toEqual({ status: "ok", value: undefined });
  });

  it("consumes a retained pending signal when a later unblocked send succeeds", async () => {
    const { table } = makeTable();
    const completion = deferred<KernelExitStatus>();
    let attempts = 0;
    const signal = vi.fn((number: number): KernelResult<void> => {
      expect(number).toBe(15);
      attempts++;
      return attempts === 1
        ? kernelError("IO_ERROR", "runner refused signal")
        : { status: "ok", value: undefined };
    });
    const spawned = table.spawn(undefined, () => child(completion.promise, signal), vi.fn());
    expect(spawned.status).toBe("ok");
    if (spawned.status !== "ok") return;
    const handle = spawned.value.handle;

    expect(table.signalMask(handle, 0, { low: 0x4000, high: 0 })).toEqual({
      status: "ok",
      value: emptyMask,
    });
    expect(table.signal(handle, 15)).toEqual({ status: "ok", value: undefined });
    expect(table.signalMask(handle, 1, { low: 0x4000, high: 0 })).toMatchObject({
      status: "error",
      error: { code: "IO_ERROR" },
    });
    expect(table.signalMask(handle, 3)).toEqual({ status: "ok", value: emptyMask });
    expect(signal).toHaveBeenCalledTimes(1);

    expect(table.signal(handle, 15)).toEqual({ status: "ok", value: undefined });
    expect(signal.mock.calls.map(([number]) => number)).toEqual([15, 15]);
    expect(table.signalMask(handle, 1, emptyMask)).toEqual({ status: "ok", value: emptyMask });
    expect(signal.mock.calls.map(([number]) => number)).toEqual([15, 15]);

    completion.resolve(exited);
    expect(await table.dispose()).toEqual({ status: "ok", value: undefined });
  });
});
