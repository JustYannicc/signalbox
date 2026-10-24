import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelCommand, KernelCommandExit } from "../../kernel/KernelCommandForwarder.ts";
import {
  commandGatewayFixture,
  emptyChild,
  spawnRequest,
} from "./CommandGatewayAdmissionFixture.ts";
import { observeTicketReservations } from "./ComputerProgramAdmissionTestSupport.ts";
import { exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("nested machine command gateway admission", () => {
  it("preserves nested machine streams, status, and prior writes without replaying Bash", async () => {
    const parentStarted = Promise.withResolvers<void>();
    const releaseParent = Promise.withResolvers<void>();
    const stdout = new Uint8Array([0, 255, 77]);
    const stderr = new Uint8Array([101, 114, 114]);
    const loaderCalls: string[] = [];
    const fixture = commandGatewayFixture({
      capacityLimit: 1,
      orderedMachineRules: [{ id: "native-tool", executable: "/opt/native" }],
      run: async (input, invocation) => {
        loaderCalls.push(input.command.executable);
        try {
          const bash = await invocation.host<KernelBashPort>();
          parentStarted.resolve();
          await releaseParent.promise;
          await bash.complete({ kind: "exit", status: exited(0) });
          return exited(0);
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const machineStarted = Promise.withResolvers<void>();
    const forwarded = emptyChild({ stdout, stderr, exited: Promise.resolve(exited(29)) });
    fixture.machineSpawn.mockImplementationOnce(async () => {
      machineStarted.resolve();
      return forwarded;
    });
    const reservations = observeTicketReservations(fixture.capacity);
    const reacquire = vi.spyOn(fixture.capacity, "run");
    let parent: Awaited<ReturnType<typeof fixture.gateway.host.spawn>> | undefined;
    let nested: Awaited<ReturnType<typeof fixture.gateway.host.spawn>> | undefined;
    const command: KernelCommand = {
      executable: "/opt/native",
      argv: ["native-argv0", "--exact", ""],
      cwd: "/workspace/nested",
      env: { EMPTY: "", TOKEN: "exact" },
    };
    try {
      fixture.write("/workspace/keep.txt", "prior-write");
      parent = await fixture.gateway.host.spawn(
        {
          filesystem: fixture.filesystem,
          parent: fixture.context.identity.handle,
          signal: fixture.controller.signal,
        },
        spawnRequest("/bin/bash", { argv: ["bash"], cwd: "/workspace", env: {} }),
      );
      if (parent.status !== "ok") throw new Error("Bash parent did not start");
      await parentStarted.promise;
      nested = await fixture.gateway.host.spawn(
        {
          filesystem: fixture.filesystem,
          parent: parent.value,
          signal: fixture.controller.signal,
        },
        spawnRequest(command.executable, {
          argv: command.argv,
          cwd: command.cwd,
          env: command.env,
        }),
      );
      if (nested.status !== "ok") throw new Error("Nested machine command did not start");
      await machineStarted.promise;
      await expect(fixture.gateway.host.exitStatus(nested.value)).resolves.toEqual({
        status: "ok",
        value: exited(29),
      });
      expect(fixture.machineSpawn).toHaveBeenCalledOnce();
      expect(fixture.machineSpawn.mock.calls[0]?.[0]).toEqual(command);
      expect(loaderCalls).toEqual(["/bin/bash"]);
      expect(fixture.stdout()).toEqual(stdout);
      expect(fixture.stderr()).toBe(new TextDecoder().decode(stderr));
      expect(fixture.read("/workspace/keep.txt")).toBe("prior-write");
      expect(reservations.requests).toHaveLength(1);
      expect(reservations.granted).toEqual(reservations.requests.map((request) => request.codeId));
      expect(reacquire).not.toHaveBeenCalled();
      expect(fixture.capacity.active).toBe(1);

      releaseParent.resolve();
      await expect(fixture.gateway.host.exitStatus(parent.value)).resolves.toMatchObject({
        status: "ok",
        value: exited(0),
      });
      expect(fixture.capacity.active).toBe(0);
    } finally {
      releaseParent.resolve();
      if (nested?.status === "ok") fixture.gateway.host.reap(nested.value);
      if (parent?.status === "ok") fixture.gateway.host.reap(parent.value);
      await fixture.close();
    }
  });

  it("cancels an admitted nested machine process without relaunching Bash", async () => {
    const parentStarted = Promise.withResolvers<void>();
    const releaseParent = Promise.withResolvers<void>();
    const loaderCalls: string[] = [];
    const fixture = commandGatewayFixture({
      capacityLimit: 1,
      orderedMachineRules: [{ id: "native-tool", executable: "/opt/native" }],
      run: async (input, invocation) => {
        loaderCalls.push(input.command.executable);
        try {
          const bash = await invocation.host<KernelBashPort>();
          parentStarted.resolve();
          await releaseParent.promise;
          await bash.complete({ kind: "exit", status: exited(0) });
          return exited(0);
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const machineStarted = Promise.withResolvers<void>();
    const machineSignal = Promise.withResolvers<number>();
    const machineExit = Promise.withResolvers<KernelCommandExit>();
    const signal = vi.fn(async (number: number) => {
      machineSignal.resolve(number);
      machineExit.resolve({ exitCode: 0, signal: number, coreDumped: false });
      return { status: "ok" as const, value: undefined };
    });
    const forwarded = emptyChild({ exited: machineExit.promise, signal });
    fixture.machineSpawn.mockImplementationOnce(async () => {
      machineStarted.resolve();
      return forwarded;
    });
    let parent: Awaited<ReturnType<typeof fixture.gateway.host.spawn>> | undefined;
    let nested: Awaited<ReturnType<typeof fixture.gateway.host.spawn>> | undefined;
    try {
      fixture.write("/workspace/keep.txt", "prior-write");
      parent = await fixture.gateway.host.spawn(
        {
          filesystem: fixture.filesystem,
          parent: fixture.context.identity.handle,
          signal: fixture.controller.signal,
        },
        spawnRequest("/bin/bash", { argv: ["bash"], cwd: "/workspace", env: {} }),
      );
      if (parent.status !== "ok") throw new Error("Bash parent did not start");
      await parentStarted.promise;
      nested = await fixture.gateway.host.spawn(
        {
          filesystem: fixture.filesystem,
          parent: parent.value,
          signal: fixture.controller.signal,
        },
        spawnRequest("/opt/native", {
          argv: ["native-argv0", "--cancel"],
          cwd: "/workspace/nested",
          env: { TOKEN: "exact" },
        }),
      );
      if (nested.status !== "ok") throw new Error("Nested machine command did not start");
      await machineStarted.promise;
      expect(fixture.gateway.host.processes.signal(nested.value, 9).status).toBe("ok");
      await expect(machineSignal.promise).resolves.toBe(9);
      await expect(fixture.gateway.host.exitStatus(nested.value)).resolves.toEqual({
        status: "ok",
        value: { exitCode: 0, signal: 9, coreDumped: false },
      });
      expect(signal).toHaveBeenCalledOnce();
      expect(loaderCalls).toEqual(["/bin/bash"]);
      expect(fixture.machineSpawn).toHaveBeenCalledOnce();
      expect(fixture.read("/workspace/keep.txt")).toBe("prior-write");
      expect(fixture.capacity.active).toBe(1);

      releaseParent.resolve();
      await expect(fixture.gateway.host.exitStatus(parent.value)).resolves.toMatchObject({
        status: "ok",
        value: exited(0),
      });
      expect(fixture.capacity.active).toBe(0);
    } finally {
      releaseParent.resolve();
      if (nested?.status === "ok") fixture.gateway.host.reap(nested.value);
      if (parent?.status === "ok") fixture.gateway.host.reap(parent.value);
      await fixture.close();
    }
  });
});
