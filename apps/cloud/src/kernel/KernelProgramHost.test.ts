import { describe, expect, it, vi } from "vite-plus/test";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  type KernelHandle,
  type RegisteredProgram,
} from "./KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { runSync } from "./wasi/internal_wasi_calls.ts";

const now = () => 1_800_000_000_000_000_001n;
const bytes = (text: string) => new TextEncoder().encode(text);
const manifest: RegisteredProgram = {
  name: "tool",
  version: "1.0.0",
  abiVersion: ABI_VERSION,
  requiredCapabilities: ["process.wait"],
  entrypoint: "tool-wasm-v1",
};

function hostFor(
  implementation: KernelProgramBinding["implementation"],
  extra: { readonly name?: string; readonly version?: string; readonly entrypoint?: string } = {},
) {
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const program = { ...manifest, ...extra };
  const binding = { manifest: program, implementation } satisfies KernelProgramBinding;
  const registered = registry.register(program);
  if (registered.status !== "ok") throw new Error("Test program registration failed");
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([["/bin/tool", binding]]),
  });
  return { host, wakes };
}

function fileSystem() {
  const fixture = sqliteFixture();
  const storage = createFacetSqliteStorage(fixture.storage, now);
  const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
  return { filesystem, fixture };
}

const wasmNoop = new WebAssembly.Module(
  Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02,
    0x01, 0x00, 0x05, 0x03, 0x01, 0x00, 0x01, 0x07, 0x13, 0x02, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72,
    0x79, 0x02, 0x00, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00, 0x0a, 0x04, 0x01, 0x02,
    0x00, 0x0b,
  ]),
);

describe("KernelProgramHost", () => {
  it("resolves only an exact executable binding and matching registered manifest", () => {
    const { host, wakes } = hostFor({ kind: "wasm", module: wasmNoop });
    try {
      expect(host.resolve("/bin/tool").status).toBe("ok");
      expect(host.resolve("/bin/tool/1.0.0")).toMatchObject({
        status: "error",
        error: { code: "NOT_FOUND" },
      });
    } finally {
      wakes.dispose();
    }
  });

  it("applies file actions in order, clears CLOEXEC for same-fd dup2, then sweeps", async () => {
    const { filesystem, fixture } = fileSystem();
    const { host, wakes } = hostFor({ kind: "wasm", module: wasmNoop });
    filesystem.mkdir("/work");
    const kept = filesystem.open(
      "/kept",
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_CLOEXEC,
    );
    const dropped = filesystem.open(
      "/dropped",
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_CLOEXEC,
    );
    const prepared = host.prepare(
      { filesystem, home: "/home/yannic" },
      {
        cwd: "/work",
        actions: [{ kind: "dup2", fd: kept, sourceFd: kept, flags: 0, mode: 0 }],
      },
    );
    try {
      expect(prepared.filesystem.cwd).toBe("/work");
      expect(prepared.home).toBe("/home/yannic");
      expect(prepared.filesystem.descriptors.get(kept).closeOnExec).toBe(false);
      expect(prepared.filesystem.descriptors.has(dropped)).toBe(false);
      expect(filesystem.descriptors.has(dropped)).toBe(true);
    } finally {
      await prepared.release();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("runs a static module inline and releases its child descriptors synchronously", () => {
    const { filesystem, fixture } = fileSystem();
    const { host, wakes } = hostFor({ kind: "wasm", module: wasmNoop });
    const resolved = host.resolve("/bin/tool");
    if (resolved.status !== "ok") throw new Error("Program resolution failed");
    const prepared = host.prepare({ filesystem });
    const childTable = prepared.filesystem.descriptors;
    expect(host.runInline(prepared, resolved.value, [], {})).toBe(0);
    expect(childTable.has(0)).toBe(false);
    void prepared.release();
    filesystem.dispose();
    fixture.close();
    wakes.dispose();
  });

  it("runs a registered synchronous JS tool in a process and preserves rich exit status", async () => {
    const { filesystem, fixture } = fileSystem();
    const runner = vi.fn(({ filesystem: child, args, env, home }) => {
      const fd = child.open("/result", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
      child.write(fd, bytes(`${args.join(",")}|${env.HOME}|${home}`), null);
      child.close(fd);
      return 7;
    });
    const { host, wakes } = hostFor({ kind: "javascript", runInline: runner });
    const resolved = host.resolve("/bin/tool");
    if (resolved.status !== "ok") throw new Error("Program resolution failed");
    const prepared = host.prepare({ filesystem, home: "/guest/home" });
    try {
      const spawned = callKernel(host.backend(prepared), "process.spawn", {
        program: resolved.value,
        args: ["one", "two"],
        env: {},
      });
      expect(spawned.status).toBe("ok");
      if (spawned.status !== "ok") throw new Error("Expected synchronous process admission");
      await expect(host.exitStatus(spawned.value)).resolves.toMatchObject({
        status: "ok",
        value: { exitCode: 7, signal: 0, coreDumped: false },
      });
      expect(runner).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["one", "two"],
          env: { HOME: "/guest/home" },
          home: "/guest/home",
        }),
      );
      const resultFd = filesystem.open("/result", KernelOpenFlags.O_RDONLY);
      const resultBytes = new Uint8Array(128);
      const resultLength = filesystem.read(resultFd, resultBytes, 0n);
      filesystem.close(resultFd);
      expect(new TextDecoder().decode(resultBytes.subarray(0, resultLength))).toContain(
        "one,two|/guest/home|/guest/home",
      );
      expect(host.processes.reap(spawned.value).status).toBe("ok");
      expect(host.processes.exitStatus(spawned.value)).toMatchObject({
        status: "error",
        error: { code: "INVALID_HANDLE" },
      });
    } finally {
      await prepared.release();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("rejects secret environment handles before local spawn admission", async () => {
    const { filesystem, fixture } = fileSystem();
    const { host, wakes } = hostFor({ kind: "wasm", module: wasmNoop });
    const resolved = host.resolve("/bin/tool");
    if (resolved.status !== "ok") throw new Error("Program resolution failed");
    const prepared = host.prepare({ filesystem });
    try {
      const secret = { id: "secret-1", kind: "secret" } as const satisfies KernelHandle<"secret">;
      expect(
        callKernel(host.backend(prepared), "process.spawn", {
          program: resolved.value,
          args: [],
          env: { TOKEN: secret },
        }),
      ).toMatchObject({ status: "error", error: { code: "UNSUPPORTED" } });
      expect(host.processes.size).toBe(0);
      expect(prepared.canTransfer).toBe(true);
    } finally {
      await prepared.release();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("connects piped child descriptors to caller streams and drains before EOF", async () => {
    const { filesystem, fixture } = fileSystem();
    const { host, wakes } = hostFor({ kind: "wasm", module: wasmNoop });
    const piped = host.preparePiped({ filesystem });
    try {
      const output = piped.prepared.filesystem.descriptors.get(1).stdio?.write;
      if (!output) throw new Error("Child stdout was not installed");
      const poll = piped.prepared.filesystem.descriptors.get(1).stdio?.poll;
      if (!poll) throw new Error("Child stdout polling was not installed");
      expect(poll("write", new AbortController().signal)).toEqual({ bytes: 65_536n });
      await output(bytes("streamed output"));
      const reader = piped.stdout.getReader();
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: bytes("streamed output"),
      });
      await piped.prepared.release();
      await expect(reader.read()).resolves.toMatchObject({ done: true });
      reader.releaseLock();
    } finally {
      await piped.prepared.release();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("disposes prepared filesystem state even when descriptor cleanup fails", async () => {
    const { filesystem, fixture } = fileSystem();
    const { host, wakes } = hostFor({ kind: "wasm", module: wasmNoop });
    const prepared = host.prepare({ filesystem });
    const closeAll = vi
      .spyOn(prepared.filesystem.descriptors, "closeAll")
      .mockImplementation(() => {
        throw new Error("close failed");
      });
    try {
      prepared.transfer();
      await expect(prepared.releaseTransferred()).rejects.toThrow("close failed");
      expect(() => prepared.filesystem.cwd).toThrow(expect.objectContaining({ code: "EBADF" }));
    } finally {
      closeAll.mockRestore();
      runSync(prepared.filesystem.descriptors.closeAll());
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });
});
