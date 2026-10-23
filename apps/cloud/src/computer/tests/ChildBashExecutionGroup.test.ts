import { expect, it, vi } from "vite-plus/test";
import { WasiError } from "../../kernel/wasi/internal_wasi_memory.ts";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { createChildBashProgram } from "../ChildBashProgram.ts";
import { ChildBashExecutionGroup } from "../ChildBashExecutionGroup.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { WORKER_LOADER_QUOTA_MESSAGES } from "../ChildWorkerDispatchError.ts";
import { createChildWorkerRunner } from "../ChildWorkerProgram.ts";
import { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";
import { createWorkerLoaderDispatch } from "../WorkerLoaderDispatch.ts";
import { bashCredentials, childBashFixture } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

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

it("keeps an unknown worker failure visible until its stop is acknowledged", async () => {
  const fixture = childBashFixture();
  const failure = new Error("unrecognized worker failure");
  let worker: LoaderInvocation | undefined;
  const { capacity, program } = createQuotaProgram(
    "test/bash-group-quota-unknown",
    async (invocation) => {
      worker = invocation;
      invocation.host();
      throw failure;
    },
  );
  try {
    await expect(program.run(fixture.context)).resolves.toEqual({
      exitCode: 0,
      signal: 9,
      coreDumped: false,
    });
    expect(capacity.active).toBe(1);
    worker!.stopped();
    await expect(program.drain()).rejects.toThrow(failure.message);
    expect(capacity.active).toBe(0);
  } finally {
    worker?.stopped();
    await program.drain().catch(() => {});
    await fixture.close();
  }
});

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
    expect(forkFailure).toBeInstanceOf(WasiError);
    expect((forkFailure as WasiError).errno).toBe(6);
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
