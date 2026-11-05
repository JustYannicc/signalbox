import { describe, expect, it, vi } from "vite-plus/test";
import { ComputerProgramOwner } from "../ComputerProgramOwner.ts";
import type { ComputerProgramOwnerOptions } from "../ComputerProgramOwner.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createKernelComputerHost } from "../../kernel/KernelComputerHost.ts";
import { createKernelExecutableNamespace } from "../../kernel/KernelExecutableNamespace.ts";
import { createKernelProcessAdmissionPort } from "../../kernel/KernelProcessAdmissionPort.ts";
import type { KernelChildHostPort } from "../../kernel/KernelChildDispatchPort.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { ChildWorkerInvocation } from "../ChildWorkerCode.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";
import { commandProgramCodes, readAll, writeStdio } from "../commandGatewayTesting.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

async function fixture(
  run: (
    input: ChildWorkerInvocation,
    host: KernelChildHostPort & KernelBashPort,
  ) => Promise<ReturnType<typeof exited>>,
  evidence?: ComputerProgramOwnerOptions["evidence"],
) {
  const kernel = childBusyboxFixture();
  const capacity = new ChildWorkerCapacity(2, {
    owner: "test/computer-owner-dispatch",
    RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
  });
  const owner = new ComputerProgramOwner({
    programs: commandProgramCodes(),
    path: ["/bin", "/usr/bin"],
    capacity,
    ...(evidence === undefined ? {} : { evidence }),
    loader: {
      async run(input, invocation) {
        if (
          !("host" in invocation) ||
          typeof invocation.host !== "function" ||
          !("stopped" in invocation) ||
          typeof invocation.stopped !== "function"
        )
          throw new Error("Child invocation is missing its control capability");
        const host = await invocation.host();
        try {
          return await run(input, host);
        } finally {
          invocation.stopped();
        }
      },
    },
  });
  const commands = await createKernelComputerHost({
    owner,
    filesystem: kernel.filesystem,
    processes: kernel.context.processes,
    wakes: kernel.context.wakes,
    hostname: "owner-test",
    home: "/guest/home",
    namespace: (request) =>
      createKernelExecutableNamespace({ filesystem: request.filesystem, signal: request.signal }),
    machine: {
      async spawn() {
        throw new Error("Unexpected machine fallback");
      },
    },
  });
  return {
    ...kernel,
    owner,
    capacity,
    commands,
    async close() {
      try {
        await commands.close();
      } finally {
        await kernel.close();
      }
    },
  };
}

describe("Computer owner dispatch", () => {
  it("releases undelivered grants after repeated admission and cancellation", async () => {
    let dispatches = 0;
    const f = await fixture(async () => {
      dispatches++;
      return exited();
    });
    const grants: { finished(): Promise<void> }[] = [];
    const requester = createKernelProcessAdmissionPort({
      processes: f.context.processes,
      process: f.context.identity.handle,
      signal: f.controller.signal,
    });
    try {
      const registration = (await f.owner.registrations()).find(
        (entry) => entry.executable === "/bin/cat",
      );
      if (registration === undefined) throw new Error("The cat registration is missing");
      for (let attempt = 0; attempt < 32; attempt++) {
        const aborted = Promise.withResolvers<{ readonly aborted: boolean }>();
        let revoked = 0;
        const namespace = createKernelExecutableNamespace({
          filesystem: f.filesystem,
          signal: f.controller.signal,
        });
        const result = await f.owner.admit(
          "reusable-admission",
          {
            kind: "command",
            command: { executable: "/bin/cat", argv: ["cat"], cwd: "/workspace", env: {} },
            target: { kind: "resolved", manifest: registration.manifest },
            localOnly: true,
          },
          {
            ...namespace,
            requester: async () => requester,
            aborted: () => aborted.promise,
            assertForwarding: async () => {
              throw new Error("This admission must remain in the isolate");
            },
            revoke: async () => {
              revoked++;
              aborted.resolve({ aborted: true });
              await namespace.close();
            },
          },
        );
        if (result.route !== "child") throw new Error("Expected an admitted child grant");
        expect(f.capacity.active).toBe(1);
        await Promise.all([
          f.owner.cancel("reusable-admission"),
          f.owner.cancel("reusable-admission"),
        ]);
        await result.grant.cancel();
        grants.push(result.grant);
        expect(revoked).toBe(1);
        expect(f.capacity.active).toBe(0);
        expect(f.capacity.waiting).toBe(0);
      }
      expect(dispatches).toBe(0);
      const child = await f.commands.exec(
        { executable: "/bin/cat", argv: ["cat"], cwd: "/workspace", env: {} },
        f.controller.signal,
        undefined,
      );
      await expect(child.exited).resolves.toEqual(exited());
      await child.dispose();
      await f.commands.drain();
      await Promise.all(grants.flatMap((grant) => [grant.finished(), grant.finished()]));
      expect(dispatches).toBe(1);
      expect(f.capacity.active).toBe(0);
    } finally {
      requester.close();
      await f.close();
    }
  });

  it("joins an interrupted admission before releasing its owner", async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(
      async () => {
        throw new Error("A cancelled admission must not dispatch");
      },
      async (_command, signal) => {
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await release.promise;
        signal.throwIfAborted();
        return {};
      },
    );
    const admission = f.commands.exec(
      { executable: "/bin/cat", argv: ["cat"], cwd: "/workspace", env: {} },
      f.controller.signal,
      undefined,
    );
    const rejected = expect(admission).rejects.toBeDefined();
    try {
      await entered.promise;
      let closed = false;
      const closing = f.owner.close().then(() => {
        closed = true;
      });
      await aborted.promise;
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      await rejected;
      expect(f.capacity.active).toBe(0);
    } finally {
      release.resolve();
      await f.close();
    }
  });
  it("dispatches through one kernel process table with bounded syscalls and real streams", async () => {
    const bytes = new Uint8Array([0, 255, 65, 10]);
    let retained: KernelChildHostPort | undefined;
    const observed: string[] = [];
    const f = await fixture(async (input, host) => {
      observed.push(input.command.executable);
      retained = host;
      await writeStdio(host, 1, bytes);
      return exited(7);
    });
    try {
      expect(f.commands.host.processes).toBe(f.context.processes);
      expect(f.commands.isolateHost.processes).toBe(f.context.processes);
      const child = await f.commands.exec(
        {
          executable: "/bin/cat",
          argv: ["custom-argv0"],
          cwd: "/workspace",
          env: { EXACT: "only" },
        },
        f.controller.signal,
        undefined,
      );
      const [stdout, exit] = await Promise.all([readAll(child.stdout), child.exited]);
      expect(stdout).toEqual(bytes);
      expect(exit).toEqual(exited(7));
      expect(observed).toEqual(["/bin/cat"]);
      await child.dispose();
      await f.commands.drain();
      expect(f.capacity.active).toBe(0);
      await expect(
        retained!.call({ name: "sched_yield", args: [], memorySize: 0, regions: [] }),
      ).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await f.close();
    }
  });

  it("preserves Bash logical completion and acknowledges its physical worker before drain", async () => {
    const stopped = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const f = await fixture(async (_input, host) => {
      await host.complete({ kind: "exit", status: exited(0) });
      completed.resolve();
      await stopped.promise;
      return exited();
    });
    try {
      const child = await f.commands.exec(
        { executable: "/bin/bash", argv: ["bash", "-c", "true"], cwd: "/workspace", env: {} },
        f.controller.signal,
        undefined,
      );
      await completed.promise;
      await expect(child.exited).resolves.toEqual(exited());
      expect(f.capacity.active).toBe(1);
      stopped.resolve();
      await f.commands.drain();
      expect(f.capacity.active).toBe(0);
      await child.dispose();
    } finally {
      stopped.resolve();
      await f.close();
    }
  });

  it("revokes queued admissions before teardown and never starts a cancelled worker", async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const f = await fixture(async () => {
      entered.resolve();
      await finish.promise;
      return exited();
    });
    try {
      const child = await f.commands.exec(
        { executable: "/bin/cat", argv: ["cat"], cwd: "/workspace", env: {} },
        f.controller.signal,
        undefined,
      );
      await entered.promise;
      finish.resolve();
      await child.exited;
      await child.dispose();
      await f.commands.drain();
      await f.owner.close();
      await expect(
        f.commands.exec(
          { executable: "/bin/cat", argv: ["cat"], cwd: "/workspace", env: {} },
          f.controller.signal,
          undefined,
        ),
      ).rejects.toMatchObject({ code: "ECANCELED" });
    } finally {
      finish.resolve();
      await f.close();
    }
  });
});
