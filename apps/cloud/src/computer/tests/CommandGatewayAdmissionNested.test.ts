import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import {
  commandGatewayFixture,
  spawnRequest,
  writeStdio,
} from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("nested command gateway admission", () => {
  it("admits a nested local spawn against the original parent context and one shared capacity", async () => {
    const parentStarted = Promise.withResolvers<void>();
    const releaseParent = Promise.withResolvers<void>();
    const nestedStdout = new Uint8Array([0, 250, 65]);
    const loaderCalls: string[] = [];
    const fixture = commandGatewayFixture({
      capacityLimit: 2,
      run: async (input, invocation) => {
        loaderCalls.push(input.command.executable);
        try {
          if (input.command.executable === "/bin/bash") {
            const bash = await invocation.host<KernelBashPort>();
            parentStarted.resolve();
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
          await writeStdio(host, 1, nestedStdout);
          return exited(17);
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const reserve = vi.spyOn(fixture.capacity, "tryReserve");
    const reacquire = vi.spyOn(fixture.capacity, "run");
    let parent: Awaited<ReturnType<typeof fixture.gateway.host.spawn>> | undefined;
    let nested: Awaited<ReturnType<typeof fixture.gateway.host.spawn>> | undefined;
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

      nested = await fixture.gateway.host.spawn(
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
      if (nested.status !== "ok") throw new Error("Nested local command did not start");
      const parentInfo = fixture.gateway.host.processes.info(parent.value);
      const nestedInfo = fixture.gateway.host.processes.info(nested.value);
      if (parentInfo.status !== "ok" || nestedInfo.status !== "ok") {
        throw new Error("Nested process ownership was not recorded");
      }
      expect(nestedInfo.value.parentPid).toBe(parentInfo.value.pid);
      await expect(fixture.gateway.host.exitStatus(nested.value)).resolves.toEqual({
        status: "ok",
        value: exited(17),
      });
      expect(fixture.capacity.active).toBe(1);
      expect(loaderCalls).toEqual(["/bin/bash", "/bin/cat"]);
      expect(reserve).toHaveBeenCalledTimes(2);
      expect(reacquire).not.toHaveBeenCalled();
      expect(fixture.capacity.active).toBe(1);

      releaseParent.resolve();
      await expect(fixture.gateway.host.exitStatus(parent.value)).resolves.toEqual({
        status: "ok",
        value: exited(31),
      });
      expect(fixture.capacity.active).toBe(0);
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
    } finally {
      releaseParent.resolve();
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
    const reserve = vi.spyOn(fixture.capacity, "tryReserve");
    const reacquire = vi.spyOn(fixture.capacity, "run");
    let root: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
    let siblingDrainSettled = false;
    try {
      root = await fixture.gateway.exec(
        { executable: "/bin/bash", argv: ["root-bash"], cwd: "/workspace", env: {} },
        fixture.controller.signal,
      );
      await rootLogicalExit.promise;
      await expect(root.exited).resolves.toEqual(exited(37));
      expect(fixture.capacity.active).toBe(1);

      const drain = fixture.gateway.drain().then(() => {
        siblingDrainSettled = true;
      });
      allowSibling.resolve();
      await siblingStarted.promise;
      const waitingPermit = fixture.capacity.acquire(new AbortController().signal);
      const parentReleasedPermit = await waitingPermit;
      await parentAcknowledged.promise;
      expect(siblingDrainSettled).toBe(false);
      expect(fixture.capacity.active).toBe(2);
      expect(siblingDrainSettled).toBe(false);
      expect(reserve).toHaveBeenCalledTimes(2);
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
