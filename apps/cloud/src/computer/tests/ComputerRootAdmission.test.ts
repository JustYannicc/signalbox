import { describe, expect, it, vi } from "vite-plus/test";
import { ABI_VERSION, KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import { KernelCommandExecutor } from "../../kernel/KernelCommandExecutor.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { createComputerProgramAdmission } from "../ComputerProgramAdmission.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

const command = (executable = "/bin/tool") => ({
  executable,
  argv: ["custom-zero", "snow雪"],
  env: { EXACT: "only", EMPTY: "" },
  cwd: "/workspace/nested",
});

describe("Computer root admission", () => {
  it.each(["abort", "prepare"] as const)(
    "releases a real unused reservation after %s without leaking owner descriptors",
    async (failure) => {
      const fixture = childBusyboxFixture();
      const capacity = new ChildWorkerCapacity(1);
      const reserve = vi.spyOn(capacity, "tryReserve");
      const machine = {
        async spawn(): Promise<never> {
          throw new Error("Unexpected machine");
        },
      };
      const adapter = createComputerProgramAdmission({
        capacity,
        machine,
        escalation: new ComputerEscalationTable(),
      });
      const admitted = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const run = vi.fn(async () => exited());
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
        programs: new Map([["/bin/tool", { manifest, implementation: { kind: "async", run } }]]),
        admit: async (request) => {
          const decision = await adapter.admit(request);
          admitted.resolve();
          await resume.promise;
          return decision;
        },
      });
      const controller = new AbortController();
      const before = [...fixture.filesystem.descriptors.entries()];
      const pending = host.spawnCommandPiped(
        { filesystem: fixture.filesystem, signal: controller.signal },
        { ...command(), ...(failure === "prepare" ? { cwd: "/missing" } : {}) },
      );
      try {
        await admitted.promise;
        expect(capacity.active).toBe(1);
        if (failure === "abort") controller.abort();
        resume.resolve();
        await expect(pending).resolves.toMatchObject({
          status: "error",
          error: { code: failure === "abort" ? "CANCELLED" : "IO_ERROR" },
        });
        expect(capacity.active).toBe(0);
        expect(reserve).toHaveBeenCalledOnce();
        expect(run).not.toHaveBeenCalled();
        expect([...fixture.filesystem.descriptors.entries()]).toEqual(before);
      } finally {
        adapter.close();
        await fixture.close();
      }
    },
  );

  it.each([false, true])(
    "claims one real reservation with genuine parent = %s",
    async (withParent) => {
      const fixture = childBusyboxFixture();
      const capacity = new ChildWorkerCapacity(1);
      const reserve = vi.spyOn(capacity, "tryReserve");
      const reacquire = vi.spyOn(capacity, "run");
      const machine = {
        spawn: vi.fn(async (): Promise<never> => {
          throw new Error("Unexpected machine");
        }),
      };
      const adapter = createComputerProgramAdmission({
        capacity,
        machine,
        escalation: new ComputerEscalationTable(),
      });
      const claim = vi.fn(adapter.reservationFor);
      let program: ReturnType<typeof createChildWorkerProgram>;
      const dispatch = vi.fn(async (input: { command: unknown }) => {
        expect(input.command).toEqual(command());
        expect(capacity.active).toBe(1);
        return exited(17);
      });
      program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules: {} },
        capacity,
        reservationFor: (context) => claim(context, program),
        createHost: (context) => {
          expect(context.home).toBe("/home/canonical");
          expect(context.env.HOME).toBeUndefined();
          expect(context.filesystem).not.toBe(fixture.filesystem);
          expect(context.filesystem.sharesBackingWith(fixture.filesystem)).toBe(true);
          const actual = context.processes.info(context.identity.handle);
          const parent = context.processes.info(
            withParent ? fixture.context.identity.handle : undefined,
          );
          if (actual.status !== "ok" || parent.status !== "ok") throw new Error("Missing process");
          expect(actual.value.parentPid).toBe(parent.value.pid);
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
      const executor = new KernelCommandExecutor({
        host,
        filesystem: fixture.filesystem,
        forwarder: machine,
        admitted: true,
        home: "/home/canonical",
        ...(withParent ? { parent: fixture.context.identity.handle } : {}),
      });
      try {
        const child = await executor.spawn(command(), fixture.context.signal);
        try {
          const [stdout, stderr, status] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect({ stdout, stderr, status }).toEqual({
            stdout: "",
            stderr: "",
            status: exited(17),
          });
        } finally {
          await child.dispose();
        }
        expect(dispatch).toHaveBeenCalledOnce();
        expect(reserve).toHaveBeenCalledOnce();
        expect(claim).toHaveBeenCalledOnce();
        expect(reacquire).not.toHaveBeenCalled();
        expect(capacity.active).toBe(0);
        expect(machine.spawn).not.toHaveBeenCalled();
      } finally {
        adapter.close();
        await fixture.close();
      }
    },
  );

  it("previews replacement stdio without effects and forwards binary pipes exactly once", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    const reserve = vi.spyOn(capacity, "tryReserve");
    const fork = vi.spyOn(fixture.filesystem.descriptors, "fork");
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const input: Uint8Array[] = [];
    const exit = Promise.withResolvers<ReturnType<typeof exited>>();
    const disposed = vi.fn(async () => {});
    const machine = {
      spawn: vi.fn(async () => ({
        stdin: new WritableStream<Uint8Array>({
          write: (chunk) => {
            input.push(chunk.slice());
          },
          close: () => {
            exit.resolve(exited(29));
          },
        }),
        stdout: new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(bytes);
            stream.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(stream) {
            stream.close();
          },
        }),
        exited: exit.promise,
        signal: async () => ({ status: "ok" as const, value: undefined }),
        dispose: disposed,
      })),
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
      admit: adapter.admit,
    });
    const executor = new KernelCommandExecutor({
      host,
      filesystem: fixture.filesystem,
      forwarder: machine,
      admitted: true,
    });
    try {
      fixture.write("/workspace/out", "prior-write");
      const processes = fixture.context.processes;
      expect(processes.signalMask(undefined, 2, { low: 2, high: 0 }).status).toBe("ok");
      await expect(
        executor.spawn(command("/bin/native"), fixture.context.signal),
      ).rejects.toMatchObject({ code: "ENOTSUP" });
      expect(fork).not.toHaveBeenCalled();
      expect(machine.spawn).not.toHaveBeenCalled();
      expect(processes.signalMask(undefined, 2, { low: 0, high: 0 }).status).toBe("ok");
      const extra = fixture.filesystem.open(
        "/workspace/out",
        KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_CLOEXEC,
      );
      const inherited = fixture.filesystem.open("/workspace/out", KernelOpenFlags.O_RDONLY);
      const before = [...fixture.filesystem.descriptors.entries()];
      await expect(
        executor.spawn(command("/bin/native"), fixture.context.signal),
      ).rejects.toMatchObject({ code: "ENOTSUP" });
      expect(fork).not.toHaveBeenCalled();
      expect([...fixture.filesystem.descriptors.entries()]).toEqual(before);
      expect(fixture.read("/workspace/out")).toBe("prior-write");
      expect(machine.spawn).not.toHaveBeenCalled();
      fixture.filesystem.close(inherited);
      fixture.filesystem.close(extra);
      // The planned pipes replace even missing inherited standard descriptors.
      for (const fd of [0, 1, 2]) fixture.filesystem.close(fd);
      const child = await executor.spawn(command("/bin/native"), fixture.context.signal);
      try {
        const writer = child.stdin.getWriter();
        await writer.write(bytes);
        await writer.close();
        const [stdout, stderr, status] = await Promise.all([
          new Response(child.stdout).bytes(),
          new Response(child.stderr).bytes(),
          child.exited,
        ]);
        expect(stdout).toEqual(bytes);
        expect(stderr).toHaveLength(0);
        expect(status).toEqual(exited(29));
      } finally {
        await child.dispose();
      }
      expect(fork).toHaveBeenCalledOnce();
      expect(machine.spawn).toHaveBeenCalledOnce();
      expect(machine.spawn).toHaveBeenCalledWith(command("/bin/native"), expect.any(AbortSignal));
      expect(disposed).toHaveBeenCalledOnce();
      expect(input).toEqual([bytes]);
      expect(reserve).not.toHaveBeenCalled();
      expect(capacity.active).toBe(0);
    } finally {
      adapter.close();
      await fixture.close();
    }
  });
});
