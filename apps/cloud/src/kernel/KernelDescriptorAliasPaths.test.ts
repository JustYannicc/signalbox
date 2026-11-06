import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import type { KernelSyscallResponse } from "./KernelSyscallPort.ts";
import { RIGHTS } from "./KernelWasiAbi.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
// What a read-write open asks for; a directory descriptor passes on no more.
const RIGHTS_ASKED = RIGHTS.FD_READ | RIGHTS.FD_WRITE | RIGHTS.FD_FILESTAT_GET;
const PATH = 64;
const OUTPUT = 1024;
const errno = { ENOENT: 44, ENOTDIR: 54, ELOOP: 32, EROFS: 69, EBADF: 8 } as const;

function kernel(
  options: {
    readonly readOnlyRoot?: true;
    readonly descriptorAlias?: (fd: number) => boolean;
  } = {},
) {
  const fixtures = [sqliteFixture(), sqliteFixture()];
  const [root, writable] = fixtures.map((fixture) =>
    createFacetSqliteStorage(fixture.storage, now),
  );
  const setup = new KernelFileSystem({ mounts: [{ path: "/", storage: root! }] });
  setup.mkdir("/a");
  setup.mkdir("/a/b");
  setup.mkdir("/w");
  setup.close(setup.open("/a/target", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY));
  setup.symlink("/a/target", "/a/link");
  setup.dispose();
  const filesystem = new KernelFileSystem({
    mounts: [
      { path: "/", storage: root!, ...(options.readOnlyRoot ? { readOnly: true } : {}) },
      { path: "/w", storage: writable! },
    ],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
    ...(options.descriptorAlias === undefined ? {} : { descriptorAlias: options.descriptorAlias }),
  });
  const directory = (path: string) =>
    filesystem.open(path, KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY);
  const call = async (
    name: "path_create_directory" | "path_unlink_file" | "path_remove_directory",
    dirfd: number,
    path: string,
  ) => {
    const bytes = new TextEncoder().encode(path);
    const response = await host.call({
      name,
      args: [dirfd, PATH, bytes.byteLength],
      memorySize: PATH + bytes.byteLength + 8,
      regions: [{ pointer: PATH, bytes }],
    });
    return returned(response).value;
  };
  /** `flags` set is how the CLI's client opens; without it, a WASI program's path_open. */
  const open = async (
    dirfd: number,
    path: string,
    options: { readonly follow?: boolean; readonly create?: boolean; readonly flags?: number } = {},
  ) => {
    const bytes = new TextEncoder().encode(path);
    const response = returned(
      await host.call({
        name: "path_open",
        args: [
          dirfd,
          options.follow === false ? 0 : 1,
          PATH,
          bytes.byteLength,
          options.create ? 1 : 0,
          RIGHTS_ASKED,
          0n,
          0,
          OUTPUT,
        ],
        memorySize: OUTPUT + 8,
        regions: [
          { pointer: PATH, bytes },
          { pointer: OUTPUT, bytes: new Uint8Array(4) },
        ],
        ...(options.flags === undefined ? {} : { kernelOpenFlags: options.flags }),
      }),
    );
    if (response.value !== 0) return { errno: response.value };
    const region = response.regions.find((item) => item.pointer === OUTPUT)!;
    return { fd: new DataView(region.bytes.buffer, region.bytes.byteOffset).getUint32(0, true) };
  };
  const exists = (path: string) => {
    try {
      filesystem.lstat(path);
      return true;
    } catch {
      return false;
    }
  };
  return {
    filesystem,
    host,
    directory,
    call,
    open,
    exists,
    close() {
      host.close();
      filesystem.dispose();
      for (const fixture of fixtures) fixture.close();
    },
  };
}

function returned(response: KernelSyscallResponse) {
  if (response.kind !== "return") throw new Error("Expected a syscall return value");
  return response;
}

describe("names under a descriptor alias", () => {
  it("creates, opens, unlinks and removes them from the root, as openat does", async () => {
    const k = kernel();
    try {
      const root = k.directory("/");
      const a = k.directory("/a");
      expect(await k.call("path_create_directory", root, `proc/self/fd/${a}/made`)).toBe(0);
      expect(k.filesystem.stat("/a/made").type).toBe("directory");
      // The CLI's client opens with kernel flags; a WASI program's path_open goes through WASI.
      const flagged = await k.open(root, `proc/self/fd/${a}/file`, {
        create: true,
        flags: KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      });
      expect(flagged.fd).toBeTypeOf("number");
      expect(k.exists("/a/file")).toBe(true);
      expect((await k.open(root, `proc/self/fd/${a}/file`)).fd).toBeTypeOf("number");
      expect(await k.call("path_unlink_file", root, `proc/self/fd/${a}/file`)).toBe(0);
      expect(k.exists("/a/file")).toBe(false);
      expect(await k.call("path_remove_directory", root, `proc/self/fd/${a}/made`)).toBe(0);
      expect(k.exists("/a/made")).toBe(false);
    } finally {
      k.close();
    }
  });

  it("fails for a closed descriptor and a file's descriptor, as Linux does", async () => {
    const k = kernel();
    try {
      const root = k.directory("/");
      const closed = k.directory("/a");
      k.filesystem.close(closed);
      const file = k.filesystem.open("/a/target", KernelOpenFlags.O_RDONLY);
      expect(await k.call("path_create_directory", root, `proc/self/fd/${closed}/x`)).toBe(
        errno.ENOENT,
      );
      expect(await k.call("path_create_directory", root, `proc/self/fd/${file}/x`)).toBe(
        errno.ENOTDIR,
      );
      expect((await k.open(root, `proc/self/fd/${closed}/x`, { flags: 0 })).errno).toBe(
        errno.ENOENT,
      );
    } finally {
      k.close();
    }
  });

  it("resolves .. from the descriptor's directory and never past its mount", async () => {
    const k = kernel();
    try {
      const root = k.directory("/");
      const b = k.directory("/a/b");
      expect(await k.call("path_create_directory", root, `proc/self/fd/${b}/../c`)).toBe(0);
      expect(k.exists("/a/c")).toBe(true);
      const w = k.directory("/w");
      expect(await k.call("path_create_directory", root, `proc/self/fd/${w}/../escape`)).not.toBe(
        0,
      );
      expect(k.exists("/escape")).toBe(false);
    } finally {
      k.close();
    }
  });

  it("does not follow a final symlink without LOOKUP_SYMLINK_FOLLOW or with O_NOFOLLOW", async () => {
    const k = kernel();
    try {
      const root = k.directory("/");
      const a = k.directory("/a");
      expect((await k.open(root, `proc/self/fd/${a}/link`, { follow: false })).errno).toBe(
        errno.ELOOP,
      );
      expect((await k.open(root, `proc/self/fd/${a}/link`)).fd).toBeTypeOf("number");
      expect(
        (await k.open(root, `proc/self/fd/${a}/link`, { flags: KernelOpenFlags.O_NOFOLLOW })).errno,
      ).toBe(errno.ELOOP);
    } finally {
      k.close();
    }
  });

  it("reads a root-relative alias as absolute only from the root", async () => {
    const k = kernel();
    try {
      const a = k.directory("/a");
      expect((await k.open(a, `proc/self/fd/${a}/target`, { flags: 0 })).errno).toBe(errno.ENOENT);
      expect(
        (await k.open(k.directory("/"), `proc/self/fd/${a}/target`, { flags: 0 })).fd,
      ).toBeTypeOf("number");
    } finally {
      k.close();
    }
  });

  it("judges a read-only mount by the descriptor's mount, not the root's", async () => {
    const k = kernel({ readOnlyRoot: true });
    try {
      const root = k.directory("/");
      const w = k.directory("/w");
      expect(await k.call("path_create_directory", root, `proc/self/fd/${w}/made`)).toBe(0);
      expect(k.exists("/w/made")).toBe(true);
      const a = k.directory("/a");
      expect(await k.call("path_create_directory", root, `proc/self/fd/${a}/made`)).toBe(
        errno.EROFS,
      );
    } finally {
      k.close();
    }
  });

  it("refuses a descriptor it does not own, even reached through a symlink", async () => {
    let hidden = -1;
    const k = kernel({ descriptorAlias: (fd) => fd !== hidden });
    try {
      const root = k.directory("/");
      hidden = k.directory("/a/b");
      k.filesystem.symlink(`/proc/self/fd/${hidden}`, "/a/sneak");
      expect(await k.call("path_create_directory", root, "a/sneak/x")).toBe(errno.EBADF);
      // The CLI's flagged open resolves in the kernel, which never follows a link into /proc.
      expect(
        (
          await k.open(root, "a/sneak/x", {
            create: true,
            flags: KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
          })
        ).errno,
      ).toBe(errno.ENOENT);
      expect(k.exists("/a/b/x")).toBe(false);
    } finally {
      k.close();
    }
  });
});
