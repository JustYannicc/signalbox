import { describe, expect, it, vi } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import type { KernelSyscallRequest } from "./KernelSyscallPort.ts";
import { setup, spawn } from "./tests/kernelProgramPipeFixture.ts";
import { wasmSigpipeCommand } from "./tests/wasmGuest.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const EPIPE = 64;
const blockedSigpipe = { low: 4096, high: 0 };
const writeRequest = (fd: number): KernelSyscallRequest => ({
  name: "fd_write",
  args: [fd, 0, 1, 12],
  memorySize: 64,
  regions: [
    { pointer: 0, bytes: new Uint8Array([16, 0, 0, 0, 1, 0, 0, 0]) },
    { pointer: 12, bytes: new Uint8Array(4) },
    { pointer: 16, bytes: new Uint8Array([121]) },
  ],
});

describe("kernel SIGPIPE generation", () => {
  it.each(["write", "sync"] as const)(
    "preserves a regular-file backend %s EPIPE as errno",
    async (phase) => {
      const database = sqliteFixture();
      const storage = createFacetSqliteStorage(database.storage, () => 1n);
      const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
      const fd = filesystem.open(
        "/regular",
        KernelOpenFlags.O_CREAT |
          KernelOpenFlags.O_WRONLY |
          (phase === "sync" ? KernelOpenFlags.O_SYNC : 0),
      );
      const fail = vi.spyOn(storage, phase).mockImplementation(() => {
        throw Object.assign(new Error("Backend failure"), { code: "EPIPE" });
      });
      const host = createKernelSyscallHost({
        filesystem,
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      try {
        expect(await host.call(writeRequest(fd))).toMatchObject({ kind: "return", value: EPIPE });
      } finally {
        fail.mockRestore();
        host.close();
        filesystem.dispose();
        database.close();
      }
    },
  );

  it("preserves a host stdio callback EPIPE as errno", async () => {
    const database = sqliteFixture();
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
      stdio: [
        {},
        {
          write() {
            throw Object.assign(new Error("Host callback failed"), { code: "EPIPE" });
          },
        },
        {},
      ],
    });
    const host = createKernelSyscallHost({
      filesystem,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    try {
      expect(await host.call(writeRequest(1))).toMatchObject({ kind: "return", value: EPIPE });
    } finally {
      host.close();
      filesystem.dispose();
      database.close();
    }
  });

  it.each([false, true])(
    "returns EPIPE for a blocked WASI SIGPIPE, inherited=%s",
    async (inherited) => {
      const context = setup({ kind: "wasm", module: wasmSigpipeCommand(!inherited, false) });
      const piped = context.host.preparePiped({ filesystem: context.filesystem });
      try {
        if (inherited)
          expect(context.host.processes.signalMask(undefined, 0, blockedSigpipe).status).toBe("ok");
        await piped.stdout.cancel();
        const child = spawn(context.host, piped);
        expect(await context.host.exitStatus(child)).toEqual({
          status: "ok",
          value: { exitCode: EPIPE, signal: 0, coreDumped: false },
        });
        expect(context.host.processes.reap(child).status).toBe("ok");
      } finally {
        await context.close(piped);
      }
    },
  );

  it("delivers pending SIGPIPE when a WASI guest unblocks it", async () => {
    const context = setup({ kind: "wasm", module: wasmSigpipeCommand(true, true) });
    const piped = context.host.preparePiped({ filesystem: context.filesystem });
    const seen = vi.spyOn(context.host.processes, "signalMask");
    try {
      await piped.stdout.cancel();
      const child = spawn(context.host, piped);
      expect(await context.host.exitStatus(child)).toEqual({
        status: "ok",
        value: { exitCode: 0, signal: 13, coreDumped: false },
      });
      expect(seen.mock.calls.some(([, how]) => how === 1)).toBe(true);
      expect(context.host.processes.reap(child).status).toBe("ok");
    } finally {
      await context.close(piped);
    }
  });

  it("queues blocked child-worker writes and applies the default action on unblock", async () => {
    const context = setup({
      kind: "async",
      async run(process) {
        expect(
          process.processes.signalMask(process.identity.handle, 0, blockedSigpipe).status,
        ).toBe("ok");
        const host = createKernelSyscallHost({ ...process, process });
        try {
          expect(await host.call(writeRequest(1))).toMatchObject({ kind: "return", value: EPIPE });
          process.processes.signalMask(process.identity.handle, 1, blockedSigpipe);
          return { exitCode: 99, signal: 0, coreDumped: false };
        } finally {
          host.close();
        }
      },
    });
    const piped = context.host.preparePiped({ filesystem: context.filesystem });
    try {
      await piped.stdout.cancel();
      const child = spawn(context.host, piped);
      expect(await context.host.exitStatus(child)).toEqual({
        status: "ok",
        value: { exitCode: 0, signal: 13, coreDumped: false },
      });
      expect(context.host.processes.reap(child).status).toBe("ok");
    } finally {
      await context.close(piped);
    }
  });
});
