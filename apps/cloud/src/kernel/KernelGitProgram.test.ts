import { describe, expect, it } from "vite-plus/test";
import { kernelOk } from "./KernelAbi.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type { AgentOsSpawnRequest } from "./AgentOsProcessWire.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelProcessTable } from "./KernelProcessTable.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelGitProcessImports } from "./git/KernelGitProcessImports.ts";
import { KernelGitFilesystemImports } from "./git/KernelGitFilesystemImports.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const encoder = new TextEncoder();
const gitCredentials = { uid: 1001, gid: 1002, euid: 1001, egid: 1002 } as const;

describe("KernelGitFilesystemImports", () => {
  it("reads persisted metadata and applies POSIX changes through dirfds", async () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, () => 1_800_000_000_000_000_001n);
    const rootMetadata = { mode: 0o755, uid: 1001, gid: 1002 } as const;
    storage.posix.initialize(storage.root, rootMetadata);
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: gitCredentials, umask: 0o022 },
    });
    const rootCredentials = { uid: 0, gid: 0, euid: 0, egid: 0 } as const;
    const rootFilesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: rootCredentials, umask: 0o022 },
    });
    const memory = new WebAssembly.Memory({ initial: 1 });
    let fileFd: number | undefined;
    let directoryFd: number | undefined;
    try {
      filesystem.mkdir("/work");
      const parent = filesystem.resolve("/work");
      const inode = filesystem.createInode(
        parent.mount,
        parent.inode,
        "file",
        { type: "file", exclusive: true },
        0o6755,
      );
      fileFd = filesystem.open("/work/file", KernelOpenFlags.O_RDWR);
      await Promise.resolve(parent.mount.storage.release(inode));
      directoryFd = filesystem.open(
        "/work",
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
      );

      const imports = new KernelGitFilesystemImports({
        memory: () => memory,
        filesystem,
        credentials: gitCredentials,
      }).imports;
      writeGuestPath(memory, 64, "file");
      expect((imports.path_stat as (...args: number[]) => number)(directoryFd, 1, 64, 4, 128)).toBe(
        0,
      );
      const view = new DataView(memory.buffer);
      expect(view.getUint32(192, true)).toBe(0o106755);
      expect(view.getUint32(196, true)).toBe(1001);
      expect(view.getUint32(200, true)).toBe(1002);

      expect(
        (imports.path_chmod as (...args: number[]) => number)(directoryFd, 1, 64, 4, 0o640),
      ).toBe(0);
      expect((imports.fd_stat as (...args: number[]) => number)(fileFd, 256)).toBe(0);
      expect(view.getUint32(320, true)).toBe(0o100640);
      expect(view.getUint32(324, true)).toBe(1001);
      expect(view.getUint32(328, true)).toBe(1002);
      expect((imports.fd_chmod as (...args: number[]) => number)(fileFd, 0o600)).toBe(0);

      expect((imports.umask as (...args: number[]) => number)(0o027, 256)).toBe(0);
      expect(view.getUint32(256, true)).toBe(0o022);
      expect(filesystem.posixPolicy?.umask).toBe(0o027);
      expect((imports.path_access as (...args: number[]) => number)(directoryFd, 0, 64, 4, 4)).toBe(
        0,
      );

      rootFilesystem.chmod("/work", 0);
      const rootImports = new KernelGitFilesystemImports({
        memory: () => memory,
        filesystem: rootFilesystem,
        credentials: rootCredentials,
      }).imports;
      writeGuestPath(memory, 64, "/work");
      expect((rootImports.path_access as (...args: number[]) => number)(-100, 0, 64, 5, 1)).toBe(0);
      writeGuestPath(memory, 64, "/work/file");
      expect((rootImports.path_access as (...args: number[]) => number)(-100, 0, 64, 10, 1)).toBe(
        2,
      );
    } finally {
      if (directoryFd !== undefined) filesystem.close(directoryFd);
      if (fileFd !== undefined) filesystem.close(fileFd);
      rootFilesystem.dispose();
      filesystem.dispose();
      fixture.close();
    }
  });

  it("does not invent metadata for legacy rows and requires matching POSIX identity", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, () => 1_800_000_000_000_000_001n);
    const rootMetadata = { mode: 0o755, uid: 1001, gid: 1002 } as const;
    storage.posix.initialize(storage.root, rootMetadata);
    const legacyFilesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    legacyFilesystem.mkdir("/legacy");
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: gitCredentials, umask: 0o022 },
    });
    try {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const imports = new KernelGitFilesystemImports({
        memory: () => memory,
        filesystem,
        credentials: gitCredentials,
      }).imports;
      writeGuestPath(memory, 64, "/legacy");
      expect((imports.path_stat as (...args: number[]) => number)(-100, 1, 64, 7, 128)).toBe(58);
      expect(
        () =>
          new KernelGitFilesystemImports({
            memory: () => memory,
            filesystem,
            credentials: { ...gitCredentials, euid: 2000 },
          }),
      ).toThrow(RangeError);
    } finally {
      filesystem.dispose();
      legacyFilesystem.dispose();
      fixture.close();
    }
  });
});

describe("KernelGitProcessImports", () => {
  it("maps the no-fork child ABI into the shared process and descriptor tables", async () => {
    const wakes = new KernelWakeRegistry();
    const processes = new KernelProcessTable({ wakes });
    const fixture = sqliteFixture();
    const filesystem = new KernelFileSystem({
      mounts: [
        {
          path: "/",
          storage: createFacetSqliteStorage(fixture.storage, () => 1_800_000_000_000_000_001n),
        },
      ],
    });
    const controller = new AbortController();
    let parentIdentity: import("./KernelProcessTable.ts").KernelProcessIdentity | undefined;
    let childCompletion: (() => void) | undefined;
    let spawnCalls = 0;
    let childKernelPid: number | undefined;
    const parent = processes.spawn(
      undefined,
      (identity) => {
        parentIdentity = identity;
        return {
          completion: new Promise((resolve) => {
            childCompletion = () => resolve({ exitCode: 0, signal: 0, coreDumped: false });
          }),
          signal: () => kernelOk(undefined),
        };
      },
      () => undefined,
    );
    try {
      expect(parent.status).toBe("ok");
      if (!parentIdentity) throw new Error("Parent process identity missing");
      const memory = new WebAssembly.Memory({ initial: 1 });
      const context = {
        filesystem,
        home: undefined,
        args: [],
        env: {},
        identity: parentIdentity,
        signal: controller.signal,
        processes,
        wakes,
        spawn: async (request: AgentOsSpawnRequest) => {
          spawnCalls++;
          expect(request).toMatchObject({
            execPath: "/bin/probe",
            argv: ["/bin/probe", "child"],
            env: { MODE: "probe" },
            cwd: "/work",
            actions: [
              { kind: "close", fd: 0 },
              { kind: "dup2", fd: 1, sourceFd: 4 },
              { kind: "close", fd: 2 },
            ],
          });
          const child = processes.spawn(
            parentIdentity!.handle,
            () => ({
              completion: Promise.resolve({ exitCode: 23, signal: 0, coreDumped: false }),
              signal: () => kernelOk(undefined),
            }),
            () => undefined,
          );
          if (child.status !== "ok") return child;
          const info = processes.info(child.value.handle);
          if (info.status === "ok") childKernelPid = info.value.pid;
          return kernelOk(child.value.handle);
        },
        exec: async () => {
          throw new Error("Unexpected exec");
        },
      } satisfies KernelAsyncProgramContext;
      const processImports = new KernelGitProcessImports({
        memory: () => memory,
        context,
        credentials: { uid: 123, gid: 456, euid: 124, egid: 457 },
      });
      const imports = processImports.imports;
      const view = new DataView(memory.buffer);
      filesystem.mkdir("/work");
      filesystem.chdir("/work");
      const cwdBytes = encoder.encode("/work");
      expect((imports.startup_cwd as (pointer: number, capacity: number) => number)(320, 0)).toBe(
        cwdBytes.byteLength,
      );
      expect(
        (imports.startup_cwd as (pointer: number, capacity: number) => number)(
          320,
          cwdBytes.byteLength,
        ),
      ).toBe(-51);
      expect(
        (imports.startup_cwd as (pointer: number, capacity: number) => number)(
          320,
          cwdBytes.byteLength + 1,
        ),
      ).toBe(cwdBytes.byteLength);
      expect(new Uint8Array(memory.buffer, 320, cwdBytes.byteLength)).toEqual(cwdBytes);
      expect(view.getUint8(320 + cwdBytes.byteLength)).toBe(0);
      expect((imports.kill as (pid: number, signal: number) => number)(404, 9)).toBe(71);
      expect(await (imports.wait as (...args: number[]) => Promise<number>)(404, 0, 272, 276)).toBe(
        12,
      );
      const argvBytes = joined("/bin/probe", "child");
      const envBytes = joined("MODE=probe");
      memoryBytes(memory, 128, argvBytes);
      memoryBytes(memory, 192, envBytes);
      memoryBytes(memory, 224, encoder.encode("/work"));

      expect((imports.ids as (pointer: number) => number)(64)).toBe(0);
      expect(processImports.suspendingImports).toEqual(["dup2", "spawn", "start", "wait"]);
      expect(view.getUint32(64, true)).toBe(123);
      expect(view.getUint32(68, true)).toBe(456);
      expect(
        await (imports.spawn as (...args: number[]) => Promise<number>)(
          128,
          argvBytes.byteLength,
          192,
          envBytes.byteLength,
          224,
          5,
          -1,
          4,
          -1,
          256,
        ),
      ).toBe(0);
      const pid = view.getInt32(256, true);
      expect(pid).toBeGreaterThan(0);
      expect(spawnCalls).toBe(0);
      expect(await (imports.start as (pid: number) => Promise<number>)(pid)).toBe(0);
      expect(spawnCalls).toBe(1);
      await Promise.resolve();
      expect(await (imports.wait as (...args: number[]) => Promise<number>)(pid, 0, 264, 268)).toBe(
        0,
      );
      expect(view.getInt32(264, true)).toBe(23 << 8);
      expect(view.getInt32(268, true)).toBe(pid);
      expect(childKernelPid).toBeDefined();
      expect(processes.waitpid(parentIdentity.handle, childKernelPid!, 1)).toMatchObject({
        status: "error",
      });
      childCompletion?.();
    } finally {
      childCompletion?.();
      await processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });
});

function joined(...values: string[]): Uint8Array {
  return encoder.encode(values.map((value) => `${value}\0`).join(""));
}

function memoryBytes(memory: WebAssembly.Memory, pointer: number, bytes: Uint8Array): void {
  new Uint8Array(memory.buffer, pointer, bytes.byteLength).set(bytes);
}

function writeGuestPath(memory: WebAssembly.Memory, pointer: number, path: string): void {
  memoryBytes(memory, pointer, encoder.encode(path));
}
