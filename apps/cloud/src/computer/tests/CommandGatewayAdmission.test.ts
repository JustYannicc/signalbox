import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import type { KernelCommand } from "../../kernel/KernelCommandForwarder.ts";
import type { ChildWorkerInvocation } from "../ChildWorkerProgram.ts";
import { CHILD_PROGRAM_PATHS } from "../ChildProgramSet.ts";
import {
  commandGatewayFixture,
  emptyChild,
  readAll,
  writeStdio,
  type FakeChildInvocation,
} from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("uniform command gateway admission", () => {
  it("registers every root spelling and shares the Bash body behind bash and sh", async () => {
    const bashBodies: unknown[] = [];
    const fixture = commandGatewayFixture({
      run: async (input, invocation) => {
        try {
          bashBodies.push(input.modules[input.mainModule]);
          const bash = await invocation.host<KernelBashPort>();
          await bash.complete({ kind: "exit", status: exited(0) });
          return exited(0);
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const children: { dispose(): Promise<void>; exited: Promise<unknown> }[] = [];
    try {
      const pathnames = Object.values(CHILD_PROGRAM_PATHS);
      const aliases = Object.keys(CHILD_PROGRAM_PATHS);
      expect(pathnames).toHaveLength(18);
      for (const executable of [...pathnames, ...aliases]) {
        expect(fixture.gateway.host.resolve(executable).status).toBe("ok");
        expect(fixture.gateway.isolateHost.resolve(executable).status).toBe("ok");
      }
      expect(fixture.gateway.host.processes).toBe(fixture.gateway.isolateHost.processes);

      for (const executable of ["/bin/bash", "/bin/sh"]) {
        const child = await fixture.gateway.exec(
          { executable, argv: [`${executable}-argv0`], cwd: "/workspace", env: {} },
          fixture.controller.signal,
        );
        children.push(child);
        await expect(child.exited).resolves.toEqual(exited(0));
      }
      expect(bashBodies).toHaveLength(2);
      expect(bashBodies[0]).toBe(bashBodies[1]);
    } finally {
      await Promise.all(children.map((child) => child.dispose()));
      await fixture.close();
    }
  });

  it("runs an admitted root locally with the original command, streams, status, and one reservation", async () => {
    const stdout = new Uint8Array([0, 255, 65, 10]);
    const stderr = new Uint8Array([128, 0, 254]);
    let observed: KernelCommand | undefined;
    const fixture = commandGatewayFixture({
      run: async (input, invocation) => {
        try {
          observed = structuredClone(input.command);
          const host = await invocation.host<KernelBusyboxPort>();
          await writeStdio(host, 1, stdout);
          await writeStdio(host, 2, stderr);
          return exited(23);
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const reserve = vi.spyOn(fixture.capacity, "tryReserve");
    const reacquire = vi.spyOn(fixture.capacity, "run");
    let child: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
    const command = {
      executable: "/bin/cat",
      argv: ["caller-cat", "-"],
      cwd: "/workspace/nested",
      env: { PATH: "/bin", EMPTY: "", TOKEN: "exact" },
    };
    try {
      child = await fixture.gateway.exec(command, fixture.controller.signal);
      const [actualStdout, actualStderr, status] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      expect(observed).toEqual(command);
      expect(observed?.argv[0]).toBe("caller-cat");
      expect(observed?.env).not.toHaveProperty("HOME");
      expect(actualStdout).toEqual(stdout);
      expect(actualStderr).toEqual(stderr);
      expect(status).toEqual(exited(23));
      expect(reserve).toHaveBeenCalledOnce();
      expect(reacquire).not.toHaveBeenCalled();
      expect(fixture.capacity.active).toBe(0);
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
    } finally {
      await child?.dispose();
      await fixture.close();
    }
  });

  it("forwards GNU-incompatible grep once with the full captured tuple", async () => {
    const stdout = new Uint8Array([0, 255, 3]);
    const stderr = new Uint8Array(["m".charCodeAt(0), "a".charCodeAt(0), "c".charCodeAt(0)]);
    const local = vi.fn(async (_input: ChildWorkerInvocation, invocation: FakeChildInvocation) => {
      invocation.acknowledge();
      return exited(99);
    });
    const fixture = commandGatewayFixture({ run: local });
    const forwarded = emptyChild({ stdout, stderr, exited: Promise.resolve(exited(29)) });
    fixture.machineSpawn.mockImplementationOnce(async () => forwarded);
    let child: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
    const command: KernelCommand = {
      executable: "/bin/grep",
      argv: ["caller-grep", "--include=*.ts", "needle", "src"],
      cwd: "/workspace/nested",
      env: { LANG: "C", EMPTY: "", TOKEN: "exact" },
    };
    try {
      child = await fixture.gateway.exec(command, fixture.controller.signal);
      const [actualStdout, actualStderr, status] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      expect(fixture.machineSpawn).toHaveBeenCalledOnce();
      expect(fixture.machineSpawn.mock.calls[0]?.[0]).toEqual(command);
      expect(local).not.toHaveBeenCalled();
      expect(actualStdout).toEqual(stdout);
      expect(actualStderr).toEqual(stderr);
      expect(status).toEqual(exited(29));
      expect(fixture.capacity.active).toBe(0);
    } finally {
      await child?.dispose();
      await fixture.close();
    }
  });

  it("keeps ordered machine rules out of local-only execution and rejects unsupported targets", async () => {
    const local = vi.fn(async (_input: ChildWorkerInvocation, invocation: FakeChildInvocation) => {
      invocation.acknowledge();
      return exited(17);
    });
    const fixture = commandGatewayFixture({
      orderedMachineRules: [{ id: "prefer-machine-cat", executable: "/bin/cat" }],
      run: local,
    });
    let machineChild: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
    let localChild: Awaited<ReturnType<typeof fixture.gateway.isolate.exec>> | undefined;
    try {
      machineChild = await fixture.gateway.exec(
        { executable: "/bin/cat", argv: ["cat"], cwd: "/workspace", env: {} },
        fixture.controller.signal,
      );
      await expect(machineChild.exited).resolves.toEqual(exited());
      expect(fixture.machineSpawn).toHaveBeenCalledOnce();

      localChild = await fixture.gateway.isolate.exec(
        { executable: "/bin/cat", argv: ["cat"], cwd: "/workspace", env: {} },
        fixture.controller.signal,
      );
      await expect(localChild.exited).resolves.toEqual(exited(17));
      expect(local).toHaveBeenCalledOnce();
      expect(fixture.machineSpawn).toHaveBeenCalledOnce();

      await expect(
        fixture.gateway.exec(
          { executable: "cd", argv: ["cd"], cwd: "/workspace", env: {} },
          fixture.controller.signal,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        fixture.gateway.isolate.exec(
          { executable: "/usr/bin/unknown", argv: ["unknown"], cwd: "/workspace", env: {} },
          fixture.controller.signal,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fixture.machineSpawn).toHaveBeenCalledOnce();
      expect(local).toHaveBeenCalledOnce();
    } finally {
      await machineChild?.dispose();
      await localChild?.dispose();
      await fixture.close();
    }
  });
});
