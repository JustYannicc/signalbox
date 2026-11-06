import { expect, it, vi } from "vite-plus/test";
import { createKernelComputerAdmission } from "./KernelComputerAdmission.ts";
import { createKernelExecutableNamespace } from "./KernelExecutableNamespace.ts";
import { KERNEL_RIPGREP_PROGRAM_MANIFEST } from "./KernelProgramArtifacts.ts";
import type { ComputerAdmissionResult } from "./KernelComputerAdmissionPort.ts";
import { childBusyboxFixture, exited } from "../computer/childBusyboxTesting.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it("keeps a cancelled grant's reply until physical completion after logical exit", async () => {
  const kernel = childBusyboxFixture();
  const physical = Promise.withResolvers<void>();
  const joinedAfterCancel = Promise.withResolvers<void>();
  const disposed = Promise.withResolvers<void>();
  const tracked: Promise<unknown>[] = [];
  let cancelled = false;
  let released = false;
  const reply = {
    route: "child",
    registration: {
      executable: "/bin/rg",
      manifest: KERNEL_RIPGREP_PROGRAM_MANIFEST,
      hostKind: "syscall",
    },
    grant: {
      async run() {
        return { ok: true, exit: exited() };
      },
      async cancel() {},
      async finished() {
        if (cancelled) joinedAfterCancel.resolve();
        await physical.promise;
      },
    },
    [Symbol.dispose]() {
      released = true;
      disposed.resolve();
    },
  } satisfies ComputerAdmissionResult & Disposable;
  const admit = createKernelComputerAdmission({
    owner: {
      registrations: async () => [reply.registration],
      admit: async () => reply,
      async cancel() {
        cancelled = true;
      },
      async close() {},
    },
    namespace: (request) =>
      createKernelExecutableNamespace({
        filesystem: request.filesystem,
        signal: request.signal,
      }),
    machine: {
      async spawn() {
        throw new Error("No machine dispatch in this lifetime test");
      },
    },
    track: (pending) => tracked.push(pending),
    hostname: "test-host",
  });
  try {
    const decision = await admit(
      {
        kind: "exec",
        command: {
          executable: "/bin/rg",
          argv: kernel.context.args,
          env: kernel.context.env,
          cwd: kernel.filesystem.cwd,
        },
        baseCwd: kernel.filesystem.cwd,
        actions: [],
        attributes: undefined,
        filesystem: kernel.filesystem,
        processes: kernel.context.processes,
        signal: kernel.context.signal,
        identity: kernel.context.identity,
        target: {
          kind: "unsupported",
          code: "NOT_FOUND",
          message: "The supplied owner already selected this test grant",
        },
      },
      true,
    );
    if (decision.kind !== "forward") throw new Error("Expected the supplied child grant");
    decision.onDispatch?.(kernel.context);
    expect(await decision.implementation.run(kernel.context)).toEqual(exited());
    decision.cancel?.();
    expect(
      await Promise.race([
        joinedAfterCancel.promise.then(() => "joined physical completion"),
        disposed.promise.then(() => "reply disposed early"),
      ]),
    ).toBe("joined physical completion");
    expect(released).toBe(false);
    physical.resolve();
    await Promise.all(tracked);
    expect(released).toBe(true);
  } finally {
    physical.resolve();
    await Promise.allSettled(tracked);
    await kernel.close();
  }
});
