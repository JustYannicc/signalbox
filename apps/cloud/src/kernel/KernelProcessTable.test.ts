import { describe, expect, it, vi } from "vitest";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { KERNEL_WNOHANG, KernelProcessTable, type KernelExitStatus } from "./KernelProcessTable.ts";
import { kernelError } from "./KernelAbi.ts";

const status = (exitCode: number, signal = 0, coreDumped = false): KernelExitStatus => ({
  exitCode,
  signal,
  coreDumped,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeTable(maxProcesses?: number) {
  const wakes = new KernelWakeRegistry();
  const table = new KernelProcessTable({ wakes, maxProcesses });
  return { table, wakes };
}

function launch(
  completion: Promise<KernelExitStatus>,
  signal = vi.fn(() => ({
    status: "ok" as const,
    value: undefined,
  })),
) {
  return { child: { completion, signal }, signal };
}

describe("KernelProcessTable", () => {
  it("assigns opaque virtual pids and records root, parent, and inherited group identity", async () => {
    const { table } = makeTable();
    const parentLaunch = launch(Promise.resolve(status(0)));
    const childLaunch = launch(Promise.resolve(status(0)));
    let child: ReturnType<typeof table.spawn> | undefined;
    const parent = table.spawn(
      undefined,
      (identity) => {
        expect(identity.pid).toBe(2);
        expect(table.info(identity.handle)).toEqual({
          status: "ok",
          value: { pid: 2, parentPid: 1, processGroupId: 1 },
        });
        child = table.spawn(identity.handle, () => childLaunch.child, vi.fn());
        return parentLaunch.child;
      },
      vi.fn(),
    );
    expect(parent.status).toBe("ok");
    if (parent.status !== "ok") return;
    expect(child?.status).toBe("ok");
    if (!child || child.status !== "ok") return;

    expect(table.info()).toEqual({
      status: "ok",
      value: { pid: 1, parentPid: 0, processGroupId: 1 },
    });
    expect(parent.value).toMatchObject({ pid: 2, handle: { kind: "process" } });
    expect(child.value).toMatchObject({ pid: 3, handle: { kind: "process" } });
    expect(table.info(parent.value.handle)).toEqual({
      status: "ok",
      value: { pid: 2, parentPid: 1, processGroupId: 1 },
    });
    expect(table.info(child.value.handle)).toEqual({
      status: "ok",
      value: { pid: 3, parentPid: 2, processGroupId: 1 },
    });
    expect(table.waitpid(undefined, child.value.pid, KERNEL_WNOHANG)).toMatchObject({
      status: "error",
      error: { code: "NOT_FOUND", message: expect.stringContaining("ECHILD") },
    });
    await table.dispose();
  });

  it("checks admission and parent ownership before starting a child", async () => {
    const { table } = makeTable(1);
    const completion = deferred<KernelExitStatus>();
    const firstLaunch = launch(completion.promise);
    const first = table.spawn(undefined, () => firstLaunch.child, vi.fn());
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;

    const launchSecond = vi.fn(() => launch(Promise.resolve(status(0))).child);
    const rejectedRelease = vi.fn();
    expect(table.spawn(undefined, launchSecond, rejectedRelease)).toMatchObject({
      status: "error",
      error: { code: "RESOURCE_LIMIT" },
    });
    expect(launchSecond).not.toHaveBeenCalled();

    const invalidParent = { id: "foreign", kind: "process" } as const;
    const launchWithInvalidParent = vi.fn(() => launch(Promise.resolve(status(0))).child);
    const invalidParentRelease = vi.fn();
    expect(table.spawn(invalidParent, launchWithInvalidParent, invalidParentRelease)).toMatchObject(
      {
        status: "error",
        error: { code: "INVALID_HANDLE" },
      },
    );
    expect(launchWithInvalidParent).not.toHaveBeenCalled();
    completion.resolve(status(0));
    await table.dispose();
    expect(rejectedRelease).toHaveBeenCalledTimes(1);
    expect(invalidParentRelease).toHaveBeenCalledTimes(1);
  });

  it("tracks a launched child when request disposal reenters its launch factory", async () => {
    const { table } = makeTable();
    const completion = deferred<KernelExitStatus>();
    const signalSent = deferred<void>();
    const signal = vi.fn(() => {
      signalSent.resolve(undefined);
      return { status: "ok" as const, value: undefined };
    });
    const release = vi.fn();
    let disposing: Promise<unknown> | undefined;
    const spawned = table.spawn(
      undefined,
      () => {
        disposing = table.dispose();
        return { completion: completion.promise, signal };
      },
      release,
    );

    expect(spawned).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
    expect(release).not.toHaveBeenCalled();
    expect(table.size).toBe(1);
    await signalSent.promise;
    expect(release).not.toHaveBeenCalled();
    completion.resolve(status(0));
    expect(await disposing).toEqual({ status: "ok", value: undefined });
    expect(release).toHaveBeenCalledTimes(1);
    expect(table.size).toBe(0);
  });

  it("lets process.wait observe completion repeatedly, then waitpid reaps once", async () => {
    const { table, wakes } = makeTable();
    const completion = deferred<KernelExitStatus>();
    const release = vi.fn();
    const childLaunch = launch(completion.promise);
    const spawned = table.spawn(undefined, () => childLaunch.child, release);
    expect(spawned.status).toBe("ok");
    if (spawned.status !== "ok") return;

    const waiting = table.wait(spawned.value.handle);
    expect(waiting.status).toBe("would_block");
    if (waiting.status !== "would_block") return;
    const wake = wakes.wait(waiting.wakeToken);
    completion.resolve(status(23, 11, true));
    expect(await wake).toEqual({ status: "ok", value: undefined });

    expect(table.wait(spawned.value.handle)).toEqual({ status: "ok", value: { exitCode: 23 } });
    expect(table.wait(spawned.value.handle)).toEqual({ status: "ok", value: { exitCode: 23 } });
    expect(release).toHaveBeenCalledTimes(1);
    expect(table.waitpid(undefined, spawned.value.pid)).toEqual({
      status: "ok",
      value: { pid: spawned.value.pid, status: status(23, 11, true) },
    });
    expect(table.waitpid(undefined, spawned.value.pid, KERNEL_WNOHANG)).toMatchObject({
      status: "error",
      error: { code: "NOT_FOUND", message: expect.stringContaining("ECHILD") },
    });
    expect(table.wait(spawned.value.handle)).toMatchObject({
      status: "error",
      error: { code: "INVALID_HANDLE" },
    });
    await table.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("exposes full exit status until explicit handle-based reap", async () => {
    const { table, wakes } = makeTable();
    const completion = deferred<KernelExitStatus>();
    const spawned = table.spawn(undefined, () => launch(completion.promise).child, vi.fn());
    expect(spawned.status).toBe("ok");
    if (spawned.status !== "ok") return;

    expect(table.lookupPid(1)).toMatchObject({
      status: "error",
      error: { code: "NOT_FOUND" },
    });
    expect(table.lookupPid(spawned.value.pid)).toEqual({
      status: "ok",
      value: {
        handle: spawned.value.handle,
        info: { pid: spawned.value.pid, parentPid: 1, processGroupId: 1 },
        status: "running",
      },
    });
    expect(table.reap(spawned.value.handle)).toMatchObject({
      status: "error",
      error: { code: "ALREADY_WAITING" },
    });

    const fullStatus = table.exitStatus(spawned.value.handle);
    const exitCode = table.wait(spawned.value.handle);
    expect(fullStatus.status).toBe("would_block");
    expect(exitCode.status).toBe("would_block");
    if (fullStatus.status !== "would_block" || exitCode.status !== "would_block") return;
    const wakeFullStatus = wakes.wait(fullStatus.wakeToken);
    const wakeExitCode = wakes.wait(exitCode.wakeToken);
    completion.resolve(status(23, 11, true));
    await Promise.all([wakeFullStatus, wakeExitCode]);

    expect(table.lookupPid(spawned.value.pid)).toMatchObject({
      status: "ok",
      value: { status: "exited" },
    });
    expect(table.exitStatus(spawned.value.handle)).toEqual({
      status: "ok",
      value: status(23, 11, true),
    });
    expect(table.exitStatus(spawned.value.handle)).toEqual({
      status: "ok",
      value: status(23, 11, true),
    });
    expect(table.reap(spawned.value.handle)).toEqual({ status: "ok", value: undefined });
    expect(table.lookupPid(spawned.value.pid)).toMatchObject({
      status: "error",
      error: { code: "NOT_FOUND" },
    });
    await table.dispose();
  });

  it("reaps failed completion by handle and reports the failure", async () => {
    const { table, wakes } = makeTable();
    const completion = deferred<KernelExitStatus>();
    const spawned = table.spawn(undefined, () => launch(completion.promise).child, vi.fn());
    expect(spawned.status).toBe("ok");
    if (spawned.status !== "ok") return;

    const waiting = table.exitStatus(spawned.value.handle);
    expect(waiting.status).toBe("would_block");
    if (waiting.status !== "would_block") return;
    const wake = wakes.wait(waiting.wakeToken);
    completion.reject(new Error("runner failed"));
    await wake;
    expect(table.lookupPid(spawned.value.pid)).toMatchObject({
      status: "ok",
      value: { status: "failed" },
    });
    expect(table.reap(spawned.value.handle)).toMatchObject({
      status: "error",
      error: { code: "IO_ERROR" },
    });
    expect(table.lookupPid(spawned.value.pid)).toMatchObject({
      status: "error",
      error: { code: "NOT_FOUND" },
    });
    await table.dispose();
  });

  it("signals matching live children by pid and process group", async () => {
    const { table } = makeTable();
    const completions = [
      deferred<KernelExitStatus>(),
      deferred<KernelExitStatus>(),
      deferred<KernelExitStatus>(),
    ];
    const signals = completions.map(() =>
      vi.fn(() => ({ status: "ok" as const, value: undefined })),
    );
    const children = completions.map((completion, index) =>
      table.spawn(
        undefined,
        () => ({ completion: completion.promise, signal: signals[index]! }),
        vi.fn(),
        index === 0 ? {} : { processGroupId: 0 },
      ),
    );
    expect(children.every((child) => child.status === "ok")).toBe(true);
    if (children.some((child) => child.status !== "ok")) return;
    const [first, second, third] = children;
    if (first?.status !== "ok" || second?.status !== "ok" || third?.status !== "ok") return;

    expect(table.signalPid(undefined, 0, 0)).toEqual({ status: "ok", value: undefined });
    expect(signals.map((signal) => signal.mock.calls.length)).toEqual([0, 0, 0]);
    expect(table.signalPid(undefined, 0, 15)).toEqual({ status: "ok", value: undefined });
    expect(signals.map((signal) => signal.mock.calls.length)).toEqual([1, 0, 0]);
    expect(table.signalPid(undefined, -second.value.pid, 9)).toEqual({
      status: "ok",
      value: undefined,
    });
    expect(signals.map((signal) => signal.mock.calls.length)).toEqual([1, 1, 0]);
    expect(table.signalPid(undefined, third.value.pid, 2)).toEqual({
      status: "ok",
      value: undefined,
    });
    expect(signals.map((signal) => signal.mock.calls.length)).toEqual([1, 1, 1]);
    expect(table.signalPid(undefined, -1, 64)).toEqual({ status: "ok", value: undefined });
    expect(signals.map((signal) => signal.mock.calls.length)).toEqual([2, 2, 2]);
    expect(table.signalPid(undefined, 999, 0)).toMatchObject({
      status: "error",
      error: { code: "NOT_FOUND" },
    });

    completions.forEach((completion) => completion.resolve(status(0)));
    await table.dispose();
  });

  it("implements any-child, process-group, and WNOHANG selection", async () => {
    const { table, wakes } = makeTable();
    const sameGroupExit = deferred<KernelExitStatus>();
    const privateGroupExit = deferred<KernelExitStatus>();
    const sameGroup = table.spawn(undefined, () => launch(sameGroupExit.promise).child, vi.fn());
    const privateGroup = table.spawn(
      undefined,
      () => launch(privateGroupExit.promise).child,
      vi.fn(),
      { processGroupId: 0 },
    );
    expect(sameGroup.status).toBe("ok");
    expect(privateGroup.status).toBe("ok");
    if (sameGroup.status !== "ok" || privateGroup.status !== "ok") return;

    expect(table.info(privateGroup.value.handle)).toMatchObject({
      status: "ok",
      value: { processGroupId: privateGroup.value.pid },
    });
    expect(table.waitpid(undefined, 0, KERNEL_WNOHANG)).toEqual({
      status: "ok",
      value: { pid: 0 },
    });
    expect(table.waitpid(undefined, -privateGroup.value.pid, KERNEL_WNOHANG)).toEqual({
      status: "ok",
      value: { pid: 0 },
    });
    expect(table.waitpid(undefined, -1, KERNEL_WNOHANG)).toEqual({
      status: "ok",
      value: { pid: 0 },
    });

    const waiting = table.waitpid(undefined, -privateGroup.value.pid);
    expect(waiting.status).toBe("would_block");
    if (waiting.status !== "would_block") return;
    const wake = wakes.wait(waiting.wakeToken);
    privateGroupExit.resolve(status(137, 9, true));
    expect(await wake).toEqual({ status: "ok", value: undefined });
    expect(table.waitpid(undefined, -privateGroup.value.pid)).toEqual({
      status: "ok",
      value: { pid: privateGroup.value.pid, status: status(137, 9, true) },
    });
    expect(table.waitpid(undefined, sameGroup.value.pid, KERNEL_WNOHANG)).toEqual({
      status: "ok",
      value: { pid: 0 },
    });
    sameGroupExit.resolve(status(0));
    await table.dispose();
  });

  it("waits for accepted cancellation to finish before releasing child resources", async () => {
    const { table, wakes } = makeTable();
    const completion = deferred<KernelExitStatus>();
    const signalSent = deferred<void>();
    const signal = vi.fn(() => {
      signalSent.resolve(undefined);
      return { status: "ok" as const, value: undefined };
    });
    const release = vi.fn();
    const spawned = table.spawn(
      undefined,
      () => ({ completion: completion.promise, signal }),
      release,
    );
    expect(spawned.status).toBe("ok");
    if (spawned.status !== "ok") return;

    const waiting = table.wait(spawned.value.handle);
    expect(waiting.status).toBe("would_block");
    if (waiting.status !== "would_block") return;
    const wake = wakes.wait(waiting.wakeToken);
    const disposing = table.dispose();
    expect(await wake).toEqual({ status: "ok", value: undefined });
    let disposeFinished = false;
    const disposal = disposing.then((result) => {
      disposeFinished = true;
      return result;
    });
    await signalSent.promise;
    expect(signal).toHaveBeenCalledWith(9);
    expect(release).not.toHaveBeenCalled();
    expect(disposeFinished).toBe(false);
    expect(table.size).toBe(1);
    expect(table.wait(spawned.value.handle)).toMatchObject({
      status: "error",
      error: { code: "CANCELLED" },
    });
    completion.resolve(status(0));
    expect(await disposal).toEqual({ status: "ok", value: undefined });
    expect(release).toHaveBeenCalledTimes(1);
    expect(table.size).toBe(0);
    expect(table.wait(spawned.value.handle)).toMatchObject({
      status: "error",
      error: { code: "INVALID_HANDLE" },
    });
  });

  it("preserves a live child after rejected cancellation and cleans it on natural exit", async () => {
    const { table } = makeTable();
    const completion = deferred<KernelExitStatus>();
    const releaseStarted = deferred<void>();
    const signal = vi.fn(() => kernelError("IO_ERROR", "runtime refused termination"));
    const release = vi.fn(() => releaseStarted.resolve(undefined));
    const spawned = table.spawn(
      undefined,
      () => ({ completion: completion.promise, signal }),
      release,
    );
    expect(spawned.status).toBe("ok");
    if (spawned.status !== "ok") return;

    expect(await table.dispose()).toMatchObject({ status: "error", error: { code: "IO_ERROR" } });
    expect(signal).toHaveBeenCalledWith(9);
    expect(release).not.toHaveBeenCalled();
    expect(table.size).toBe(1);
    expect(table.info(spawned.value.handle)).toMatchObject({
      status: "ok",
      value: { pid: spawned.value.pid },
    });

    completion.resolve(status(31));
    await releaseStarted.promise;
    expect(release).toHaveBeenCalledTimes(1);
    expect(await table.dispose()).toEqual({ status: "ok", value: undefined });
    expect(table.size).toBe(0);
  });

  it("runs cleanup after a launch failure and drains asynchronous release", async () => {
    const { table } = makeTable();
    const cleanupStarted = deferred<void>();
    const allowCleanup = deferred<void>();
    const release = vi.fn(async () => {
      cleanupStarted.resolve(undefined);
      await allowCleanup.promise;
    });
    expect(
      table.spawn(
        undefined,
        () => {
          throw new Error("launch failed");
        },
        release,
      ),
    ).toMatchObject({
      status: "error",
      error: { code: "IO_ERROR" },
    });
    await cleanupStarted.promise;
    const disposing = table.dispose();
    allowCleanup.resolve(undefined);
    expect(await disposing).toEqual({ status: "ok", value: undefined });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reaps a completion failure once without inventing an exit status", async () => {
    const { table, wakes } = makeTable();
    const completion = deferred<KernelExitStatus>();
    const release = vi.fn();
    const spawned = table.spawn(undefined, () => launch(completion.promise).child, release);
    expect(spawned.status).toBe("ok");
    if (spawned.status !== "ok") return;

    const waiting = table.waitpid(undefined, -1);
    expect(waiting.status).toBe("would_block");
    if (waiting.status !== "would_block") return;
    const wake = wakes.wait(waiting.wakeToken);
    completion.reject(new Error("runner failed"));
    expect(await wake).toEqual({ status: "ok", value: undefined });
    expect(release).toHaveBeenCalledTimes(1);
    expect(table.waitpid(undefined, -1)).toMatchObject({
      status: "error",
      error: { code: "IO_ERROR" },
    });
    expect(table.waitpid(undefined, -1, KERNEL_WNOHANG)).toMatchObject({
      status: "error",
      error: { code: "NOT_FOUND", message: expect.stringContaining("ECHILD") },
    });
    await table.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("turns hostile or out-of-range exit statuses into completion errors", async () => {
    const getterThrows = Object.defineProperty({}, "exitCode", {
      get() {
        throw new Error("hostile status getter");
      },
    }) as unknown as KernelExitStatus;
    const invalidStatuses = [getterThrows, status(0x1_0000_0000), status(0, 65)];

    for (const invalidStatus of invalidStatuses) {
      const { table, wakes } = makeTable();
      const completion = deferred<KernelExitStatus>();
      const spawned = table.spawn(undefined, () => launch(completion.promise).child, vi.fn());
      expect(spawned.status).toBe("ok");
      if (spawned.status !== "ok") return;

      const waiting = table.wait(spawned.value.handle);
      expect(waiting.status).toBe("would_block");
      if (waiting.status !== "would_block") return;
      const wake = wakes.wait(waiting.wakeToken);
      completion.resolve(invalidStatus);
      expect(await wake).toEqual({ status: "ok", value: undefined });
      expect(table.wait(spawned.value.handle)).toMatchObject({
        status: "error",
        error: { code: "IO_ERROR" },
      });
      expect(table.waitpid(undefined, -1)).toMatchObject({
        status: "error",
        error: { code: "IO_ERROR" },
      });
      await table.dispose();
    }
  });
});
