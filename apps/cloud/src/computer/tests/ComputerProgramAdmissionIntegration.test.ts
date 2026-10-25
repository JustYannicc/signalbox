import { describe, expect, it, vi } from "vite-plus/test";
import { ABI_VERSION, KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import type { AgentOsSpawnRequest } from "../../kernel/AgentOsProcessWire.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { createComputerProgramAdmission } from "../ComputerProgramAdmission.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

function spawnRequest(
  execPath: string,
  actions: AgentOsSpawnRequest["actions"] = [],
): AgentOsSpawnRequest {
  return {
    execPath,
    argv: ["custom-zero", "snow雪"],
    env: { EXACT: "only", EMPTY: "" },
    cwd: "/workspace/nested",
    actions,
    pidPointer: 0,
    attributes: {
      flags: 0,
      defaultMask: { low: 0, high: 0 },
      signalMask: { low: 0, high: 0 },
      processGroup: 0,
    },
  };
}

describe("Computer admission through the public kernel host", () => {
  it.each([false, true])("spends one local reservation with catalog alias=%s", async (alias) => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    const capacityRun = vi.spyOn(capacity, "run");
    const machine = {
      spawn: vi.fn(async () => {
        throw new Error("Unexpected machine call");
      }),
    };
    const adapter = createComputerProgramAdmission({
      capacity,
      machine,
      escalation: new ComputerEscalationTable(),
      ...(alias
        ? {
            resolve: async (request) => ({
              command: request.command,
              catalog: {
                command: { ...request.command, executable: "/bin/tool" },
                binding: { manifest, implementation: program },
              },
            }),
          }
        : {}),
    });
    let program: ReturnType<typeof createChildWorkerProgram>;
    const request = spawnRequest(alias ? "/usr/bin/tool" : "/bin/tool");
    const dispatch = vi.fn(async (input: { command: unknown }) => {
      expect(input.command).toEqual({
        executable: "/bin/tool",
        argv: request.argv,
        env: request.env,
        cwd: request.cwd,
      });
      expect(capacity.active).toBe(1);
      return exited(17);
    });
    program = createChildWorkerProgram({
      executable: "/bin/tool",
      code: { mainModule: "entry.js", modules: {} },
      capacity,
      reservationFor: (context) => adapter.reservationFor(context, program),
      createHost: (context) => {
        expect(context.filesystem).not.toBe(fixture.filesystem);
        expect(context.filesystem.sharesBackingWith(fixture.filesystem)).toBe(true);
        return { host: {}, close() {} };
      },
      dispatch: { run: dispatch },
    });
    const manifest = {
      name: "tool",
      version: "1",
      abiVersion: ABI_VERSION,
      entrypoint: "tool",
      requiredCapabilities: [],
    };
    const registry = new KernelProgramRegistry();
    registry.register(manifest);
    const host = new KernelProgramHost({
      registry,
      wakes: fixture.context.wakes,
      processes: fixture.context.processes,
      programs: new Map([["/bin/tool", { manifest, implementation: program }]]),
      admit: adapter.admit,
    });
    try {
      const spawned = await host.spawn(
        {
          filesystem: fixture.filesystem,
          parent: fixture.context.identity.handle,
          signal: fixture.context.signal,
          home: "/not-an-env-variable",
        },
        request,
      );
      if (spawned.status !== "ok") throw new Error(`Spawn failed: ${JSON.stringify(spawned)}`);
      await expect(host.exitStatus(spawned.value)).resolves.toEqual({
        status: "ok",
        value: exited(17),
      });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(capacityRun).not.toHaveBeenCalled();
      expect(capacity.active).toBe(0);
      expect(machine.spawn).not.toHaveBeenCalled();
    } finally {
      adapter.close();
      await fixture.close();
    }
  });

  it("forwards once using prepared redirection and refuses extra fds before truncation", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    const disposed = vi.fn(async () => {});
    const received: unknown[] = [];
    const machine = {
      spawn: vi.fn(async (command: unknown) => {
        received.push(command);
        return {
          stdin: new WritableStream<Uint8Array>(),
          stdout: new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode("machine-result"));
              stream.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(stream) {
              stream.close();
            },
          }),
          exited: Promise.resolve(exited(17)),
          signal: async () => ({ status: "ok" as const, value: undefined }),
          dispose: disposed,
        };
      }),
    };
    const adapter = createComputerProgramAdmission({
      capacity,
      machine,
      escalation: new ComputerEscalationTable([{ id: "native", executable: "/bin/native" }]),
    });
    const host = new KernelProgramHost({
      registry: new KernelProgramRegistry(),
      wakes: fixture.context.wakes,
      processes: fixture.context.processes,
      programs: new Map(),
      admit: adapter.admit,
    });
    const redirect = {
      kind: "open" as const,
      fd: 1,
      sourceFd: 0,
      flags: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
      mode: 0o600,
      path: "/workspace/out",
    };
    try {
      fixture.write("/workspace/out", "prior-write");
      const inherited = fixture.filesystem.open("/workspace/out", KernelOpenFlags.O_RDONLY);
      const input = {
        filesystem: fixture.filesystem,
        parent: fixture.context.identity.handle,
        signal: fixture.context.signal,
      };
      await expect(
        host.spawn(input, spawnRequest("/bin/native", [redirect])),
      ).rejects.toMatchObject({ code: "ENOTSUP" });
      expect(fixture.read("/workspace/out")).toBe("prior-write");
      expect(machine.spawn).not.toHaveBeenCalled();
      fixture.filesystem.close(inherited);
      const request = spawnRequest("/bin/native", [redirect]);
      const spawned = await host.spawn(input, request);
      if (spawned.status !== "ok") throw new Error(`Spawn failed: ${JSON.stringify(spawned)}`);
      await expect(host.exitStatus(spawned.value)).resolves.toEqual({
        status: "ok",
        value: exited(17),
      });
      expect(received).toEqual([
        { executable: "/bin/native", argv: request.argv, env: request.env, cwd: request.cwd },
      ]);
      expect(fixture.read("/workspace/out")).toBe("machine-result");
      expect(machine.spawn).toHaveBeenCalledOnce();
      expect(disposed).toHaveBeenCalledOnce();
      expect(capacity.active).toBe(0);
    } finally {
      adapter.close();
      await fixture.close();
    }
  });
});
