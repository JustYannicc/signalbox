import { expect, it, vi } from "vite-plus/test";
import { kernelOk } from "../KernelAbi.ts";
import type { KernelAsyncProgramContext } from "../KernelAsyncProgram.ts";
import { createKernelBashHost } from "../KernelBashHost.ts";
import type { KernelBashForkSource } from "../KernelBashFork.ts";
import { KernelFileSystem } from "../KernelFileSystem.ts";
import { KernelProcessTable, type KernelExitStatus } from "../KernelProcessTable.ts";
import { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import { createKernelSyscallHost } from "../KernelSyscallHost.ts";
import type { WasiStdio } from "../Wasi.ts";
import { createFacetSqliteStorage } from "../FacetSqliteStorage.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

const posixCredentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 } as const;
const bashCredentials = {
  ...posixCredentials,
  umask: 0o022,
  hostname: "kernel-test",
} as const;

it("maps a serialized failed-fork errno through the public syscall host", async () => {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  let serializedError: Error | undefined;
  const stderrWrite = vi.fn((_source: Uint8Array, _flags: number): never => {
    if (serializedError === undefined) throw new Error("Serialized failure is not set");
    throw serializedError;
  });
  const stdio: readonly [WasiStdio, WasiStdio, WasiStdio] = [{}, {}, { write: stderrWrite }];
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/workspace", storage }],
    stdio,
    cwd: "/workspace",
    posix: { credentials: posixCredentials, umask: 0o022 },
  });
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({ wakes });
  const controller = new AbortController();
  const rootExit = deferred<KernelExitStatus>();
  let identity: KernelAsyncProgramContext["identity"] | undefined;
  const root = processes.spawn(
    undefined,
    (processIdentity) => {
      identity = processIdentity;
      return {
        completion: rootExit.promise,
        signal: () => {
          rootExit.resolve({ exitCode: 0, signal: 0, coreDumped: false });
          return kernelOk(undefined);
        },
      };
    },
    () => undefined,
  );
  if (root.status !== "ok" || identity === undefined)
    throw new Error("Could not create public Bash test context");

  const context: KernelAsyncProgramContext = {
    filesystem,
    home: "/workspace",
    args: [],
    env: {},
    identity,
    signal: controller.signal,
    processes,
    wakes,
    spawn: async () => {
      throw new Error("Unexpected direct process spawn");
    },
    exec: async () => {
      throw new Error("Unexpected Bash exec");
    },
  };
  const rawQuotaFailure = Object.assign(new Error("quota rejected"), { code: "EAGAIN" });
  const quotaFailure = structuredClone(rawQuotaFailure) as Error & { readonly code?: string };
  const isStoppedQuotaFailure = vi.fn((error: unknown) => error === quotaFailure);
  const owner = createKernelBashHost({
    context,
    credentials: bashCredentials,
    isStoppedQuotaFailure,
    async runFork() {
      throw quotaFailure;
    },
  });
  const source: KernelBashForkSource = {
    async state() {
      throw new Error("Fork state should not be read by the failing host");
    },
    async read() {
      throw new Error("Fork bytes should not be read by the failing host");
    },
    async restored() {},
  };
  let syscallHost: ReturnType<typeof createKernelSyscallHost> | undefined;

  try {
    expect(quotaFailure.code).toBeUndefined();
    const forked = await owner.port.fork();
    expect(forked.kind).toBe("fork");
    if (forked.kind !== "fork") throw new Error("Public Bash fork did not create a child");

    let producedError: unknown;
    try {
      await forked.port.runFork(source);
    } catch (error) {
      producedError = error;
    }
    expect(isStoppedQuotaFailure).toHaveBeenCalledTimes(1);
    expect(isStoppedQuotaFailure).toHaveBeenCalledWith(quotaFailure);
    expect(producedError).toBeInstanceOf(Error);
    if (!(producedError instanceof Error)) throw new Error("Failed fork did not produce an Error");

    const standardError = structuredClone(producedError) as Error & {
      readonly code?: string;
      readonly errno?: number;
    };
    expect(standardError.name).toBe("Error");
    expect(standardError.message).toBe("WASI error: 6");
    expect("code" in standardError).toBe(false);
    expect("errno" in standardError).toBe(false);
    serializedError = standardError;

    syscallHost = createKernelSyscallHost({
      filesystem,
      args: [],
      env: {},
      signal: controller.signal,
    });
    const payload = new TextEncoder().encode("quota failure");
    const iovec = new Uint8Array(8);
    const iovecView = new DataView(iovec.buffer);
    iovecView.setUint32(0, 16, true);
    iovecView.setUint32(4, payload.byteLength, true);
    const response = await syscallHost.call({
      name: "fd_write",
      args: [2, 0, 1, 8],
      memorySize: 32,
      regions: [
        { pointer: 0, bytes: iovec, direction: "in" },
        { pointer: 8, bytes: new Uint8Array(), direction: "out", length: 4 },
        { pointer: 16, bytes: payload, direction: "in" },
      ],
    });

    expect(response).toMatchObject({ kind: "return", value: 6 });
    expect(stderrWrite).toHaveBeenCalledTimes(1);
    expect(stderrWrite).toHaveBeenCalledWith(payload, expect.any(Number));
    expect(standardError.message).toBe("WASI error: 6");
  } finally {
    syscallHost?.close();
    await owner.close();
    controller.abort();
    rootExit.resolve({ exitCode: 0, signal: 0, coreDumped: false });
    await processes.dispose();
    filesystem.dispose();
    database.close();
    wakes.dispose();
  }
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => (resolve = done));
  return { promise, resolve };
}
