import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import type { KernelProgramAdmissionRequest } from "../../kernel/KernelProgramAdmission.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { KernelProcessSignal } from "../../kernel/KernelProcessSignal.ts";
import {
  assertComputerForwardingSupported,
  createComputerForwardedProgram,
} from "../ComputerForwardedProgram.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

function preflight(
  fixture: ReturnType<typeof childBusyboxFixture>,
  actions: KernelProgramAdmissionRequest["actions"] = [],
): KernelProgramAdmissionRequest {
  return {
    kind: "exec",
    command: {
      executable: "/bin/grep",
      argv: fixture.context.args,
      cwd: fixture.filesystem.cwd,
      env: fixture.context.env,
    },
    baseCwd: fixture.filesystem.cwd,
    actions,
    attributes: undefined,
    filesystem: fixture.filesystem,
    processes: fixture.context.processes,
    identity: fixture.context.identity,
    signal: fixture.context.signal,
    target: { kind: "unsupported", code: "NOT_FOUND", message: "Not registered" },
  };
}

describe("Computer forwarded programs", () => {
  it("pumps binary stdin and output through the actual process descriptors and settles cleanup", async () => {
    const bytes = new Uint8Array([0, 255, 65, 10]);
    const fixture = childBusyboxFixture({
      stdin: bytes,
      args: ["override-zero", "雪"],
      env: { ONLY: "value", EMPTY: "" },
    });
    const input: Uint8Array[] = [];
    const consumed = Promise.withResolvers<void>();
    const dispose = vi.fn(async () => {});
    const command = {
      executable: "/bin/grep",
      argv: fixture.context.args,
      cwd: fixture.filesystem.cwd,
      env: fixture.context.env,
    };
    const spawn = vi.fn(async () => ({
      stdin: new WritableStream<Uint8Array>({
        write: (chunk) => {
          input.push(chunk.slice());
        },
        close: () => consumed.resolve(),
      }),
      stdout: new ReadableStream<Uint8Array>({
        start: (stream) => {
          stream.enqueue(bytes);
          stream.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start: (stream) => {
          stream.enqueue(new TextEncoder().encode("err雪"));
          stream.close();
        },
      }),
      exited: consumed.promise.then(() => exited(17)),
      signal: async () => ({ status: "ok" as const, value: undefined }),
      dispose,
    }));
    try {
      const program = createComputerForwardedProgram({ spawn }, command);
      await expect(program.run(fixture.context)).resolves.toEqual(exited(17));
      expect(spawn).toHaveBeenCalledExactlyOnceWith(command, fixture.context.signal);
      expect(input).toEqual([bytes]);
      expect(fixture.stdout()).toEqual(bytes);
      expect(fixture.stderr()).toBe("err雪");
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  });

  it("delivers the actual process signal and waits for machine disposal", async () => {
    const fixture = childBusyboxFixture();
    const started = Promise.withResolvers<void>();
    const disposed = Promise.withResolvers<void>();
    const allowDisposal = Promise.withResolvers<void>();
    const signal = vi.fn(async () => ({ status: "ok" as const, value: undefined }));
    let settled = false;
    const child: KernelCommandChild = {
      stdin: new WritableStream(),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      exited: new Promise(() => {}),
      signal,
      dispose: async () => {
        disposed.resolve();
        await allowDisposal.promise;
      },
    };
    const command = {
      executable: "/bin/tool",
      argv: fixture.context.args,
      cwd: fixture.filesystem.cwd,
      env: fixture.context.env,
    };
    try {
      const running = createComputerForwardedProgram(
        {
          spawn: async () => {
            started.resolve();
            return child;
          },
        },
        command,
      )
        .run(fixture.context)
        .finally(() => {
          settled = true;
        });
      const failure = expect(running).rejects.toBeInstanceOf(KernelProcessSignal);
      await started.promise;
      fixture.controller.abort(new KernelProcessSignal(15));
      await disposed.promise;
      expect(signal).toHaveBeenCalledExactlyOnceWith(15);
      expect(settled).toBe(false);
      allowDisposal.resolve();
      await failure;
    } finally {
      allowDisposal.resolve();
      await fixture.close();
    }
  });

  it("refuses a surviving extra descriptor before a truncating file action can run", async () => {
    const fixture = childBusyboxFixture();
    try {
      fixture.write("/workspace/out", "keep me");
      const fd = fixture.filesystem.open("/workspace/out", KernelOpenFlags.O_RDONLY);
      const action = {
        kind: "open" as const,
        fd: 1,
        sourceFd: 0,
        flags: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
        mode: 0o600,
        path: "/workspace/out",
      };
      expect(() => assertComputerForwardingSupported(preflight(fixture, [action]))).toThrow(
        "extra descriptors",
      );
      expect(fixture.read("/workspace/out")).toBe("keep me");
      fixture.filesystem.close(fd);
    } finally {
      await fixture.close();
    }
  });

  it("accepts an ordered temporary descriptor closed before the exec sweep", async () => {
    const fixture = childBusyboxFixture();
    try {
      const open = {
        kind: "open" as const,
        fd: 30,
        sourceFd: 0,
        flags: KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
        mode: 0o600,
        path: "/workspace/new",
      };
      const close = { kind: "close" as const, fd: 30, sourceFd: 0, flags: 0, mode: 0 };
      expect(() =>
        assertComputerForwardingSupported(preflight(fixture, [open, close])),
      ).not.toThrow();
      expect(() => fixture.read("/workspace/new")).toThrow();
      expect(() =>
        assertComputerForwardingSupported(
          preflight(fixture, [{ ...open, flags: open.flags | KernelOpenFlags.O_CLOEXEC }]),
        ),
      ).not.toThrow();
    } finally {
      await fixture.close();
    }
  });
});
