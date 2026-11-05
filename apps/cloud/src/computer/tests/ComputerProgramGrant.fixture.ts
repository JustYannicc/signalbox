import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import {
  createChildWorkerInvocationRunner,
  type ChildWorkerDispatch,
} from "../ChildWorkerInvocationRunner.ts";
import { ComputerProgramGrant } from "../ComputerProgramGrant.ts";
import { createComputerProgramCatalog } from "../ComputerProgramCatalog.ts";
import { commandProgramCodes } from "../commandGatewayTesting.ts";
import { ChildHostLease } from "../ChildHostLease.ts";
import { childBusyboxFixture, busyboxCredentials, exited } from "./ChildBusyboxFixture.ts";
import { createWorkerBashHost } from "../../kernel/KernelBashWorkerHost.ts";
import type { KernelChildHostPort } from "../../kernel/KernelChildDispatchPort.ts";
import type {
  KernelBashPhasePort,
  KernelBashWorkerPort,
} from "../../kernel/KernelBashDispatchPort.ts";
import type { KernelCommandExit } from "../../kernel/KernelCommandForwarder.ts";

function duplicated<T extends object>(port: T, dispose: () => void) {
  let active = 0;
  const released = Promise.withResolvers<void>();
  return {
    active: () => active,
    released: released.promise,
    port: {
      ...port,
      dup() {
        active++;
        let closed = false;
        return {
          ...port,
          [Symbol.dispose]() {
            if (closed) return;
            closed = true;
            active--;
            dispose();
            released.resolve();
          },
        };
      },
    },
  };
}

export async function computerProgramGrantFixture(
  dispatch: ChildWorkerDispatch<KernelChildHostPort | KernelBashWorkerPort> = {
    run: async () => exited(),
  },
) {
  const kernel = childBusyboxFixture({ args: ["/bin/bash"] });
  const capacity = new ChildWorkerCapacity(2, {
    owner: "test/phase-capabilities",
    RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
  });
  const descriptor = createComputerProgramCatalog(commandProgramCodes()).programs.get("/bin/bash");
  if (descriptor === undefined) throw new Error("Bash program is missing");
  const runner = createChildWorkerInvocationRunner({
    executable: descriptor.implementation,
    code: descriptor.code,
    capacity,
    dispatch,
  });
  const command = { executable: "/bin/bash", argv: ["bash"], cwd: "/workspace", env: {} };
  const requester = {
    describe: async () => ({ scope: "phase-kernel", parentPid: 1 }),
    bind: async () => {},
  };
  const reservation = await capacity.reserve(
    kernel.controller.signal,
    { owner: requester },
    await runner.prepare(),
  );
  const parentExit = Promise.withResolvers<KernelCommandExit>();
  const parentFinished = Promise.withResolvers<void>();
  const parentAbort = Promise.withResolvers<{ readonly aborted: boolean }>();
  const entered = Promise.withResolvers<void>();
  const parent = duplicated(
    {
      describe: async () => ({ command, requester }),
      open: async (): Promise<KernelChildHostPort> => {
        throw new Error("Unexpected non-Bash open");
      },
      aborted: () => parentAbort.promise,
      close: async () => {},
      cancel: async () => {},
      bash: async () => {
        entered.resolve();
        return await parentExit.promise;
      },
      finished: () => parentFinished.promise,
    },
    () => parentAbort.resolve({ aborted: false }),
  );
  let finished = 0;
  const grant = new ComputerProgramGrant(
    { descriptor, runner },
    reservation,
    kernel.controller,
    {
      inspect: async () => ({ type: "file", lower: false, matchesArtifact: true }),
      requester: async () => requester,
      assertForwarding: async () => {},
      aborted: () => parentAbort.promise,
      revoke: async () => {},
    },
    () => {
      finished++;
    },
  );
  const running = grant.run(parent.port);
  await entered.promise;
  return {
    grant,
    runner,
    parent,
    capacity,
    signal: kernel.controller.signal,
    phase(
      options: {
        readonly describeFailure?: Error;
        readonly openFailure?: Error;
        readonly keepAbortPendingAfterDisposal?: boolean;
      } = {},
    ) {
      const abort = Promise.withResolvers<{
        readonly aborted: boolean;
        readonly reason?: unknown;
      }>();
      let stopped = 0;
      let revoked = 0;
      const lease = new ChildHostLease();
      let host: ReturnType<typeof createWorkerBashHost> | undefined;
      const port: KernelBashPhasePort = {
        describe: async () => {
          if (options.describeFailure !== undefined) throw options.describeFailure;
          return { command, requester };
        },
        open: async () => {
          if (options.openFailure !== undefined) throw options.openFailure;
          host = createWorkerBashHost(
            {
              context: kernel.context,
              credentials: { ...busyboxCredentials, umask: 0o022, hostname: "phase-test" },
            },
            lease,
          );
          return host.host;
        },
        aborted: () => abort.promise,
        failure: async () => {},
        revoke: async () => {
          revoked++;
          lease.release();
          await host?.close();
        },
        stopped: async () => {
          stopped++;
        },
      };
      const capability = duplicated(port, () => {
        if (!options.keepAbortPendingAfterDisposal)
          abort.reject(new Error("Completed phase stub disposed"));
      });
      return {
        ...capability,
        abort: (reason: unknown) => abort.resolve({ aborted: true, reason }),
        stopped: () => stopped,
        revoked: () => revoked,
      };
    },
    async close() {
      reservation.cancel();
      parentExit.resolve(exited());
      parentFinished.resolve();
      parentAbort.resolve({ aborted: false });
      try {
        await running;
        await grant.finished();
        await runner.drain();
      } finally {
        await kernel.close();
      }
      if (finished !== 1) throw new Error("Grant did not finish exactly once");
    },
  };
}
