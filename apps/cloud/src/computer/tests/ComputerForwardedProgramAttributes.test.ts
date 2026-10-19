import { describe, expect, it, vi } from "vite-plus/test";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  callKernel,
  kernelOk,
} from "../../kernel/KernelAbi.ts";
import type { AgentOsSpawnRequest } from "../../kernel/AgentOsProcessWire.ts";
import { KernelProgramExecAdmissionError } from "../../kernel/KernelAsyncProgram.ts";
import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createComputerProgramAdmission } from "../ComputerProgramAdmission.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { childBusyboxFixture, exited, text } from "./ChildBusyboxFixture.ts";

function machinePort() {
  return {
    spawn: vi.fn(async () => ({
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(text("machine output"));
          stream.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start: (stream) => stream.close() }),
      exited: Promise.resolve(exited(17)),
      signal: async () => ({ status: "ok" as const, value: undefined }),
      dispose: async () => {},
    })),
  };
}

describe("machine process attributes", () => {
  it("refuses SETPGROUP with group zero before applying a truncating redirection", async () => {
    const fixture = childBusyboxFixture();
    const machine = machinePort();
    const admission = createComputerProgramAdmission({
      capacity: new ChildWorkerCapacity(1),
      machine,
      escalation: new ComputerEscalationTable([{ id: "native", executable: "/bin/native" }]),
    });
    const host = new KernelProgramHost({
      registry: new KernelProgramRegistry(),
      processes: fixture.context.processes,
      wakes: fixture.context.wakes,
      admit: admission.admit,
    });
    const request: AgentOsSpawnRequest = {
      execPath: "/bin/native",
      argv: ["native"],
      env: {},
      actions: [
        {
          kind: "open",
          fd: 1,
          sourceFd: 0,
          flags: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
          mode: 0o600,
          path: "/workspace/out",
        },
      ],
      attributes: {
        flags: 2,
        processGroup: 0,
        defaultMask: { low: 0, high: 0 },
        signalMask: { low: 0, high: 0 },
      },
      pidPointer: 0,
    };
    try {
      fixture.write("/workspace/out", "keep me");
      await expect(
        host.spawn(
          {
            filesystem: fixture.filesystem,
            parent: fixture.context.identity.handle,
            signal: fixture.context.signal,
          },
          request,
        ),
      ).rejects.toMatchObject({ code: "ENOTSUP" });
      expect(fixture.read("/workspace/out")).toBe("keep me");
      expect(machine.spawn).not.toHaveBeenCalled();
    } finally {
      admission.close();
      await fixture.close();
    }
  });

  it.each([
    { label: "custom inherited group", newGroup: true, mask: 0, refused: true },
    { label: "inherited signal mask", newGroup: false, mask: 2, refused: true },
    { label: "default inherited attributes", newGroup: false, mask: 0, refused: false },
  ])("checks $label before the exec CLOEXEC sweep", async (testCase) => {
    const fixture = childBusyboxFixture();
    const machine = machinePort();
    const admission = createComputerProgramAdmission({
      capacity: new ChildWorkerCapacity(1),
      machine,
      escalation: new ComputerEscalationTable([{ id: "native", executable: "/bin/native" }]),
    });
    const parentExit = Promise.withResolvers<ReturnType<typeof exited>>();
    const parent = fixture.context.processes.spawn(
      fixture.context.identity.handle,
      () => ({ completion: parentExit.promise, signal: () => kernelOk(undefined) }),
      () => {},
      {
        ...(testCase.newGroup ? { processGroupId: 0 } : {}),
        signalMask: { low: testCase.mask, high: 0 },
      },
    );
    if (parent.status !== "ok") throw new Error("Could not create exec parent");
    let execFailure: unknown;
    let cloexecSurvived: boolean | undefined;
    const run = async (context: KernelAsyncProgramContext) => {
      const info = context.processes.info(context.identity.handle);
      if (info.status !== "ok") throw new Error("Could not inspect exec process");
      expect(info.value.parentPid).toBe(parent.value.pid);
      expect(info.value.processGroupId).not.toBe(context.identity.pid);
      const fd = context.filesystem.open(
        "/workspace/cloexec",
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_CLOEXEC,
      );
      try {
        return await context.exec({
          filesystem: context.filesystem,
          identity: context.identity,
          signal: context.signal,
          args: ["native"],
          env: {},
          path: "/bin/native",
        });
      } catch (error) {
        execFailure = error;
        return exited(0);
      } finally {
        cloexecSurvived = context.filesystem.descriptors.has(fd);
      }
    };
    const manifest = {
      name: "root",
      version: "1",
      abiVersion: ABI_VERSION,
      requiredCapabilities: [],
      entrypoint: "root",
    };
    const registry = new KernelProgramRegistry();
    registry.register(manifest);
    const host = new KernelProgramHost({
      registry,
      processes: fixture.context.processes,
      wakes: fixture.context.wakes,
      programs: new Map([["/bin/root", { manifest, implementation: { kind: "async", run } }]]),
      admit: admission.admit,
    });
    try {
      fixture.write("/workspace/cloexec", "keep me");
      const resolved = host.resolve("/bin/root");
      if (resolved.status !== "ok") throw new Error("Could not resolve exec caller");
      const prepared = host.prepare({
        filesystem: fixture.filesystem,
        parent: parent.value.handle,
        signal: fixture.context.signal,
      });
      const spawned = callKernel(host.backend(prepared), "process.spawn", {
        program: resolved.value,
        args: [],
        env: {},
      });
      await prepared.release();
      if (spawned.status !== "ok") throw new Error("Could not start exec caller");
      await expect(host.exitStatus(spawned.value)).resolves.toMatchObject({
        status: "ok",
        value: exited(testCase.refused ? 0 : 17),
      });
      if (testCase.refused) {
        expect(execFailure).toBeInstanceOf(KernelProgramExecAdmissionError);
        expect(execFailure).toMatchObject({ code: "ENOTSUP" });
        expect(machine.spawn).not.toHaveBeenCalled();
        expect(fixture.stdout()).toEqual(new Uint8Array());
      } else {
        expect(execFailure).toBeUndefined();
        expect(machine.spawn).toHaveBeenCalledOnce();
        expect(fixture.stdout()).toEqual(text("machine output"));
      }
      expect(cloexecSurvived).toBe(testCase.refused);
    } finally {
      admission.close();
      parentExit.resolve(exited());
      await fixture.close();
    }
  });
});
