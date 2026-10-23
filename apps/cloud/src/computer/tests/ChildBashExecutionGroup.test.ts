import { expect, it, vi } from "vite-plus/test";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import type { KernelBashOperation, KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelExitStatus } from "../../kernel/KernelProcessTable.ts";
import { createChildBashProgram } from "../ChildBashProgram.ts";
import { ChildBashExecutionGroup } from "../ChildBashExecutionGroup.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { WORKER_LOADER_QUOTA_MESSAGES } from "../ChildWorkerDispatchError.ts";
import { createChildWorkerRunner } from "../ChildWorkerProgram.ts";
import { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";
import { createWorkerLoaderDispatch } from "../WorkerLoaderDispatch.ts";
import { bashCredentials, childBashFixture } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

function nestedErrors(error: unknown, visited = new Set<unknown>()): unknown[] {
  if (visited.has(error)) return [];
  visited.add(error);
  const causes =
    error instanceof AggregateError
      ? error.errors
      : error instanceof Error && error.cause !== undefined
        ? [error.cause]
        : [];
  return [error, ...causes.flatMap((cause) => nestedErrors(cause, visited))];
}

it("keeps a fork killed before restore available for its parent's waitpid", async () => {
  const fixture = childBashFixture();
  const capacity = new ChildWorkerCapacity(1, {
    owner: "test/bash-execution-group-killed-before-restore",
  });
  const killed = { exitCode: 0, signal: 9, coreDumped: false };
  const runner = createChildWorkerRunner<KernelBashPort>({
    executable: "/bin/bash",
    code: { mainModule: "main.js", modules: { "main.js": "export default {}" } },
    capacity,
    dispatch: { run: async () => killed },
  });
  const group = new ChildBashExecutionGroup(runner, runner, bashCredentials);
  const owner = createKernelBashHost({
    context: fixture.context,
    credentials: bashCredentials,
    runFork: (context, forkOwner, snapshot) => group.run(context, forkOwner, snapshot),
  });
  const restored = vi.fn(async () => {});
  const source: KernelBashForkSource = {
    async state() {
      return {
        version: 1,
        memoryBytes: 0,
        stackPointer: 0,
        continuation: { resume: 0 },
        captures: {
          stack: { low: 0, high: 0, log: 0 },
          base: 0,
          size: 0,
          names: [],
          stackNames: [],
          captures: [],
          top: 0,
          liveBytes: 0,
          nextId: 1,
          nextGeneration: 1,
        },
      };
    },
    read: async () => new Uint8Array(),
    restored,
  };
  try {
    const forked = await owner.port.fork();
    if (forked.kind !== "fork") throw new Error("The test fork could not start");
    expect(await forked.port.runFork(source)).toEqual(killed);
    expect(restored).not.toHaveBeenCalled();
    expect(await owner.port.wait(forked.pid, 0)).toEqual({
      kind: "wait",
      pid: forked.pid,
      status: killed,
    });
    await group.finish(owner.close);
    expect(capacity.active).toBe(0);
  } finally {
    await owner.close();
    await fixture.close();
  }
});

type LoaderInvocation = {
  host(): unknown;
  stopped(): void;
};

const quotaMessage = WORKER_LOADER_QUOTA_MESSAGES[1];

function quotaFailure() {
  return Object.assign(new Error(quotaMessage), { code: "EAGAIN" });
}

function createQuotaProgram(
  owner: string,
  run: (
    invocation: LoaderInvocation,
  ) => Promise<{ exitCode: number; signal: number; coreDumped: boolean }>,
) {
  const capacity = new ChildWorkerCapacity(2, { owner });
  const lifetimes = new ChildWorkerLifetimes();
  const dispatch = createWorkerLoaderDispatch<KernelBashPort>({
    run: async (_input, invocation) => run(invocation as unknown as LoaderInvocation),
  });
  const program = createChildBashProgram({
    executable: "/bin/bash",
    code: { mainModule: "main.js", modules: { "main.js": "export default {}" } },
    capacity,
    dispatch,
    credentials: bashCredentials,
    lifetimes,
  });
  return { capacity, program };
}

function emptyForkSource(): KernelBashForkSource {
  return {
    async state() {
      return {
        version: 1,
        memoryBytes: 0,
        stackPointer: 0,
        continuation: { resume: 0 },
        captures: {
          stack: { low: 0, high: 0, log: 0 },
          base: 0,
          size: 0,
          names: [],
          stackNames: [],
          captures: [],
          top: 0,
          liveBytes: 0,
          nextId: 1,
          nextGeneration: 1,
        },
      };
    },
    read: async () => new Uint8Array(),
    restored: async () => {},
  };
}

async function parkPendingExec(host: KernelBashPort) {
  const operation: KernelBashOperation = {
    kind: "exec",
    request: { path: "/bin/tool", args: ["tool"], env: {} },
  };
  const started = await host.startOperation!(operation);
  if (started.kind !== "pending") throw new Error("Exec did not park");
  const state = await emptyForkSource().state();
  await host.park!(
    {
      state: async () => ({
        ...state,
        continuation: {
          resume: 0,
          pending: {
            kind: "operation",
            operation,
            call: { namespace: "nimbus_proc", name: "execve", args: [] },
          },
          operationId: started.id,
        },
      }),
      read: async () => new Uint8Array(),
      restored: async () => {},
    },
    started.id,
  );
}

it("reports an initial confirmed root quota rejection as a command failure", async () => {
  const fixture = childBashFixture();
  const { capacity, program } = createQuotaProgram("test/bash-group-quota-initial", async () => {
    throw quotaFailure();
  });
  try {
    await expect(program.run(fixture.context)).rejects.toMatchObject({ message: quotaMessage });
    await expect(program.drain()).resolves.toBeUndefined();
    expect(capacity.active).toBe(0);
  } finally {
    await program.drain().catch(() => {});
    await fixture.close();
  }
});

it("completes a parked exec without reacquiring a Bash worker", async () => {
  const replacement = { exitCode: 7, signal: 0, coreDumped: false };
  const fixture = childBashFixture({ exec: async () => replacement });
  let invocations = 0;
  const { capacity, program } = createQuotaProgram(
    "test/bash-group-completed-exec",
    async (invocation) => {
      invocations++;
      const host = invocation.host() as KernelBashPort & {
        forkSnapshot(): KernelBashForkSource | undefined;
      };
      if (invocations === 1) {
        const operation = {
          kind: "exec" as const,
          request: { path: "/bin/tool", args: ["tool"], env: {} },
        };
        const started = await host.startOperation!(operation);
        if (started.kind !== "pending") throw new Error("Exec did not park");
        const state = await emptyForkSource().state();
        await host.park!(
          {
            state: async () => ({
              ...state,
              continuation: {
                resume: 0,
                pending: {
                  kind: "operation",
                  operation,
                  call: { namespace: "nimbus_proc", name: "execve", args: [] },
                },
                operationId: started.id,
              },
            }),
            read: async () => new Uint8Array(),
            restored: async () => {},
          },
          started.id,
        );
      } else {
        await host.forkSnapshot()!.restored();
      }
      invocation.stopped();
      return invocations === 1 ? { exitCode: 0, signal: 0, coreDumped: false } : replacement;
    },
  );
  try {
    await expect(program.run(fixture.context)).resolves.toEqual(replacement);
    await expect(program.drain()).resolves.toBeUndefined();
    expect(invocations).toBe(1);
    expect(capacity.active).toBe(0);
  } finally {
    await program.drain().catch(() => {});
    await fixture.close();
  }
});

it("drains a parked Bash operation cancelled by its owning signal", async () => {
  const fixture = childBashFixture();
  const controller = new AbortController();
  const operationStarted = Promise.withResolvers<void>();
  const context = {
    ...fixture.context,
    signal: controller.signal,
    exec: (request: { readonly signal: AbortSignal }) =>
      new Promise<KernelExitStatus>((_resolve, reject) => {
        operationStarted.resolve();
        const abort = () => reject(request.signal.reason);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      }),
  };
  const { capacity, program } = createQuotaProgram(
    "test/bash-group-cancelled-parked-operation",
    async (invocation) => {
      const host = invocation.host() as KernelBashPort;
      await parkPendingExec(host);
      invocation.stopped();
      return { exitCode: 0, signal: 0, coreDumped: false };
    },
  );
  const run = program.run(context);
  try {
    await operationStarted.promise;
    expect(capacity.active).toBe(0);
    controller.abort();
    await expect(run).resolves.toEqual({ exitCode: 0, signal: 9, coreDumped: false });
    await expect(program.drain()).resolves.toBeUndefined();
    expect(capacity.active).toBe(0);
  } finally {
    controller.abort();
    await program.drain().catch(() => {});
    await fixture.close();
  }
});

it("discards parked processes after a cancelled dispatch stop is acknowledged", async () => {
  const fixture = childBashFixture();
  const controller = new AbortController();
  const operationStarted = Promise.withResolvers<void>();
  const parked = Promise.withResolvers<void>();
  const acknowledgeStop = Promise.withResolvers<void>();
  const context = {
    ...fixture.context,
    signal: controller.signal,
    exec: (request: { readonly signal: AbortSignal }) =>
      new Promise<KernelExitStatus>((_resolve, reject) => {
        operationStarted.resolve();
        const abort = () => reject(request.signal.reason);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      }),
  };
  const { capacity, program } = createQuotaProgram(
    "test/bash-group-cancelled-dispatch",
    async (invocation) => {
      const host = invocation.host() as KernelBashPort;
      await parkPendingExec(host);
      parked.resolve();
      await acknowledgeStop.promise;
      controller.abort();
      invocation.stopped();
      await host.complete({
        kind: "exit",
        status: { exitCode: 0, signal: 0, coreDumped: false },
      });
      return { exitCode: 0, signal: 0, coreDumped: false };
    },
  );
  const run = program.run(context);
  try {
    await parked.promise;
    await operationStarted.promise;
    expect(capacity.active).toBe(1);
    acknowledgeStop.resolve();
    await expect(run).resolves.toEqual({ exitCode: 0, signal: 9, coreDumped: false });
    await expect(program.drain()).resolves.toBeUndefined();
    expect(capacity.active).toBe(0);
  } finally {
    controller.abort();
    acknowledgeStop.resolve();
    await program.drain().catch(() => {});
    await fixture.close();
  }
});

it("closes pending operations after an unknown parked dispatch failure", async () => {
  const fixture = childBashFixture();
  const controller = new AbortController();
  const failure = new Error("Unknown failure while parked");
  const context = {
    ...fixture.context,
    signal: controller.signal,
    exec: (request: { readonly signal: AbortSignal }) =>
      new Promise<KernelExitStatus>((_resolve, reject) => {
        const abort = () => reject(request.signal.reason);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      }),
  };
  const { capacity, program } = createQuotaProgram(
    "test/bash-group-unknown-parked-dispatch",
    async (invocation) => {
      await parkPendingExec(invocation.host() as KernelBashPort);
      invocation.stopped();
      throw failure;
    },
  );
  try {
    await expect(program.run(context)).resolves.toEqual({
      exitCode: 0,
      signal: 9,
      coreDumped: false,
    });
    const rejected = await program.drain().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(nestedErrors(rejected)).toContain(failure);
    expect(capacity.active).toBe(0);
  } finally {
    controller.abort();
    await program.drain().catch(() => {});
    await fixture.close();
  }
});

it("reports a resumed confirmed root quota rejection as a command failure", async () => {
  const fixture = childBashFixture();
  let invocations = 0;
  const { capacity, program } = createQuotaProgram(
    "test/bash-group-quota-resumed",
    async (invocation) => {
      invocations++;
      if (invocations === 1) {
        const host = invocation.host() as KernelBashPort;
        if (host.park === undefined) throw new Error("The root Bash host cannot park");
        await host.park(emptyForkSource());
        invocation.stopped();
        return { exitCode: 0, signal: 0, coreDumped: false };
      }
      throw quotaFailure();
    },
  );
  try {
    await expect(program.run(fixture.context)).rejects.toMatchObject({ message: quotaMessage });
    expect(invocations).toBe(2);
    await expect(program.drain()).resolves.toBeUndefined();
    expect(capacity.active).toBe(0);
  } finally {
    await program.drain().catch(() => {});
    await fixture.close();
  }
});

it.each([
  { message: "unrecognized worker failure after cancellation", name: "Error" },
  { message: "Bash process still has an active operation", name: "Error" },
  { message: "spoofed cancellation", name: "KernelProcessCancelledError" },
])(
  "keeps an unknown worker failure after cancellation: $name: $message",
  async ({ message, name }) => {
    const fixture = childBashFixture();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const failWorker = Promise.withResolvers<void>();
    const failure = Object.assign(new Error(message), { name });
    let worker: LoaderInvocation | undefined;
    const { capacity, program } = createQuotaProgram(
      "test/bash-group-unknown-failure-after-cancel",
      async (invocation) => {
        worker = invocation;
        invocation.host();
        entered.resolve();
        await failWorker.promise;
        throw failure;
      },
    );
    const run = program.run({ ...fixture.context, signal: controller.signal });
    try {
      await entered.promise;
      controller.abort();
      failWorker.resolve();
      expect(capacity.active).toBe(1);
      worker!.stopped();
      await expect(run).resolves.toEqual({
        exitCode: 0,
        signal: 9,
        coreDumped: false,
      });
      await expect(program.drain()).rejects.toThrow(failure.message);
      expect(capacity.active).toBe(0);
    } finally {
      controller.abort();
      worker?.stopped();
      await program.drain().catch(() => {});
      await fixture.close();
    }
  },
);

it("turns a fork quota rejection into EAGAIN with one clean waitpid reap", async () => {
  const fixture = childBashFixture();
  let invocations = 0;
  let forkFailure: unknown;
  let waited: Awaited<ReturnType<KernelBashPort["wait"]>> | undefined;
  let forkPid: number | undefined;
  const waitpid = vi.spyOn(fixture.processes, "waitpid");
  const { capacity, program } = createQuotaProgram(
    "test/bash-group-quota-fork",
    async (invocation) => {
      invocations++;
      if (invocations > 1) throw quotaFailure();

      const host = invocation.host() as KernelBashPort;
      const child = await host.fork();
      if (child.kind !== "fork") throw new Error("The test fork could not start");
      forkPid = child.pid;
      try {
        await child.port.runFork(emptyForkSource());
      } catch (error) {
        forkFailure = error;
      }
      waited = await host.wait(child.pid, 0);
      await host.complete({ kind: "exit", status: { exitCode: 0, signal: 0, coreDumped: false } });
      invocation.stopped();
      return { exitCode: 0, signal: 0, coreDumped: false };
    },
  );
  try {
    await expect(program.run(fixture.context)).resolves.toEqual({
      exitCode: 0,
      signal: 0,
      coreDumped: false,
    });
    await expect(program.drain()).resolves.toBeUndefined();
    expect(forkFailure).toMatchObject({ errno: 6, message: "WASI error: 6" });
    expect(waited).toEqual({
      kind: "wait",
      pid: forkPid,
      status: { exitCode: 0, signal: 0, coreDumped: false },
    });
    expect(waitpid).toHaveBeenCalledOnce();
    expect(capacity.active).toBe(0);
  } finally {
    await program.drain().catch(() => {});
    await fixture.close();
  }
});
