import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import type { KernelBashForkSource, KernelBashForkState } from "../../kernel/KernelBashFork.ts";
import {
  commandGatewayFixture,
  spawnRequest,
  writeStdio,
} from "./CommandGatewayAdmissionFixture.ts";
import { observeTicketReservations } from "./ComputerProgramAdmissionTestSupport.ts";
import { exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("nested command gateway admission", () => {
  it("admits a nested local spawn against the original parent context and one shared capacity", async () => {
    const parentStarted = Promise.withResolvers<void>();
    const allowPark = Promise.withResolvers<void>();
    const parentResumed = Promise.withResolvers<void>();
    const releaseParent = Promise.withResolvers<void>();
    const nestedStarted = Promise.withResolvers<void>();
    const releaseNested = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<{ inFlight: number; waiting: number }>();
    const nestedStdout = new Uint8Array([0, 250, 65]);
    const memory = new Uint8Array([0, 255, 77, 10]);
    const state: KernelBashForkState = {
      version: 1,
      memoryBytes: memory.length,
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
    const source: KernelBashForkSource = {
      state: async () => state,
      read: async (offset, length) => memory.slice(offset, offset + length),
      restored: async () => {},
    };
    const loaderCalls: string[] = [];
    let parentRuns = 0;
    const fixture = commandGatewayFixture({
      capacityLimit: 1,
      run: async (input, invocation) => {
        loaderCalls.push(input.command.executable);
        try {
          expect(fixture.capacity.active).toBe(1);
          if (input.command.executable === "/bin/bash") {
            const bash = await invocation.host<
              KernelBashPort & { forkSnapshot(): Promise<KernelBashForkSource | undefined> }
            >();
            if (++parentRuns === 1) {
              parentStarted.resolve();
              await allowPark.promise;
              if (!bash.park) throw new Error("Bash host omitted its parking capability");
              await bash.park(source);
              return exited();
            }
            const snapshot = await bash.forkSnapshot();
            if (!snapshot) throw new Error("Parked parent resumed without its checkpoint");
            expect(await snapshot.state()).toEqual(state);
            expect(await snapshot.read(0, memory.length)).toEqual(memory);
            await snapshot.restored();
            parentResumed.resolve();
            await releaseParent.promise;
            await bash.complete({ kind: "exit", status: exited(31) });
            return exited(31);
          }
          expect(input.command).toEqual({
            executable: "/bin/cat",
            argv: ["caller-cat", "nested"],
            cwd: "/workspace/nested",
            env: { PATH: "/bin", EMPTY: "" },
          });
          const host = await invocation.host<KernelBusyboxPort>();
          nestedStarted.resolve();
          await releaseNested.promise;
          await writeStdio(host, 1, nestedStdout);
          return exited(17);
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const reservations = observeTicketReservations(fixture.capacity);
    const reacquire = vi.spyOn(fixture.capacity, "run");
    const unsubscribe = fixture.capacity.onPressure((pressure) => {
      if (pressure.kind === "capacity") queued.resolve(pressure);
    });
    let parent: Awaited<ReturnType<typeof fixture.gateway.host.spawn>> | undefined;
    let nested: Awaited<ReturnType<typeof fixture.gateway.host.spawn>> | undefined;
    let nestedLaunch: ReturnType<typeof fixture.gateway.host.spawn> | undefined;
    try {
      parent = await fixture.gateway.host.spawn(
        {
          filesystem: fixture.filesystem,
          parent: fixture.context.identity.handle,
          signal: fixture.controller.signal,
          home: "/guest/home",
        },
        spawnRequest("/bin/bash", {
          argv: ["caller-bash", "-c", "nested"],
          cwd: "/workspace",
          env: { PATH: "/bin" },
        }),
      );
      if (parent.status !== "ok") throw new Error("Bash parent did not start");
      await parentStarted.promise;
      expect(fixture.capacity.active).toBe(1);

      nestedLaunch = fixture.gateway.host.spawn(
        {
          filesystem: fixture.filesystem,
          parent: parent.value,
          signal: fixture.controller.signal,
          home: "/guest/home",
        },
        spawnRequest("/bin/cat", {
          argv: ["caller-cat", "nested"],
          cwd: "/workspace/nested",
          env: { PATH: "/bin", EMPTY: "" },
        }),
      );
      void nestedLaunch.catch(() => undefined);
      expect(await queued.promise).toMatchObject({ inFlight: 1, waiting: 1 });
      expect(fixture.capacity.active).toBe(1);
      expect(loaderCalls).toEqual(["/bin/bash"]);
      expect(reservations.granted).toHaveLength(1);
      allowPark.resolve();
      nested = await nestedLaunch;
      if (nested.status !== "ok") throw new Error("Nested local command did not start");
      await nestedStarted.promise;
      const parentInfo = fixture.gateway.host.processes.info(parent.value);
      const nestedInfo = fixture.gateway.host.processes.info(nested.value);
      if (parentInfo.status !== "ok" || nestedInfo.status !== "ok") {
        throw new Error("Nested process ownership was not recorded");
      }
      expect(nestedInfo.value.parentPid).toBe(parentInfo.value.pid);
      expect(fixture.gateway.host.processes.exitStatus(parent.value).status).toBe("would_block");
      expect(parentRuns).toBe(1);
      expect(fixture.capacity.active).toBe(1);
      releaseNested.resolve();
      await expect(fixture.gateway.host.exitStatus(nested.value)).resolves.toEqual({
        status: "ok",
        value: exited(17),
      });
      await parentResumed.promise;
      expect(fixture.capacity.active).toBe(1);
      expect(loaderCalls).toEqual(["/bin/bash", "/bin/cat", "/bin/bash"]);
      expect(fixture.stdout()).toEqual(nestedStdout);
      expect(reservations.requests).toHaveLength(2);
      expect(reservations.granted).toEqual(reservations.requests.map((request) => request.codeId));
      expect(reacquire).toHaveBeenCalledOnce();
      expect(fixture.capacity.active).toBe(1);

      releaseParent.resolve();
      await expect(fixture.gateway.host.exitStatus(parent.value)).resolves.toEqual({
        status: "ok",
        value: exited(31),
      });
      expect(fixture.capacity.active).toBe(0);
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      allowPark.resolve();
      releaseNested.resolve();
      releaseParent.resolve();
      if (nestedLaunch) nested = await nestedLaunch;
      if (nested?.status === "ok") fixture.gateway.host.reap(nested.value);
      if (parent?.status === "ok") fixture.gateway.host.reap(parent.value);
      await fixture.close();
    }
  });

  it("keeps a shared physical lifetime drain open for a late local sibling on the other host", async () => {
    const rootLogicalExit = Promise.withResolvers<void>();
    const allowSibling = Promise.withResolvers<void>();
    const siblingStarted = Promise.withResolvers<void>();
    const releaseSibling = Promise.withResolvers<void>();
    const parentAcknowledged = Promise.withResolvers<void>();
    let lateSibling: KernelCommandChild | undefined;
    let fixture!: ReturnType<typeof commandGatewayFixture>;
    fixture = commandGatewayFixture({
      capacityLimit: 2,
      run: async (input, invocation) => {
        try {
          if (input.command.argv[0] === "root-bash") {
            const bash = await invocation.host<KernelBashPort>();
            await bash.complete({ kind: "exit", status: exited(37) });
            rootLogicalExit.resolve();
            await allowSibling.promise;
            const sibling = await fixture.gateway.isolate.exec(
              { executable: "/bin/pwd", argv: ["pwd"], cwd: "/workspace", env: {} },
              fixture.controller.signal,
              undefined,
            );
            lateSibling = sibling;
            void sibling.exited.catch(() => undefined);
            await siblingStarted.promise;
            invocation.acknowledge();
            parentAcknowledged.resolve();
            return exited(37);
          }
          siblingStarted.resolve();
          await releaseSibling.promise;
          if (input.command.executable === "/bin/bash") {
            const bash = await invocation.host<KernelBashPort>();
            await bash.complete({ kind: "exit", status: exited(0) });
          }
          return exited(0);
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const reservations = observeTicketReservations(fixture.capacity);
    const reacquire = vi.spyOn(fixture.capacity, "run");
    let root: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
    let siblingDrainSettled = false;
    try {
      root = await fixture.gateway.exec(
        { executable: "/bin/bash", argv: ["root-bash"], cwd: "/workspace", env: {} },
        fixture.controller.signal,
        undefined,
      );
      await rootLogicalExit.promise;
      await expect(root.exited).resolves.toEqual(exited(37));
      expect(fixture.capacity.active).toBe(1);

      const drain = fixture.gateway.drain().then(() => {
        siblingDrainSettled = true;
      });
      allowSibling.resolve();
      await siblingStarted.promise;
      const waitingPermit = fixture.capacity.acquire(new AbortController().signal, undefined);
      const parentReleasedPermit = await waitingPermit;
      await parentAcknowledged.promise;
      expect(siblingDrainSettled).toBe(false);
      expect(fixture.capacity.active).toBe(2);
      expect(siblingDrainSettled).toBe(false);
      expect(reservations.requests).toHaveLength(2);
      expect(reservations.granted).toEqual(reservations.requests.map((request) => request.codeId));
      expect(reacquire).not.toHaveBeenCalled();
      parentReleasedPermit.release();
      expect(fixture.capacity.active).toBe(1);
      releaseSibling.resolve();
      await lateSibling?.exited;
      await lateSibling?.dispose();
      await drain;
      expect(siblingDrainSettled).toBe(true);
      expect(fixture.capacity.active).toBe(0);
    } finally {
      allowSibling.resolve();
      releaseSibling.resolve();
      await lateSibling?.exited.catch(() => undefined);
      await lateSibling?.dispose();
      await root?.dispose();
      await fixture.close();
    }
  });
});
