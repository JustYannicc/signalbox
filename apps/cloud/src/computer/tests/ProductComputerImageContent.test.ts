import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import { createProductComputer } from "../ProductComputer.ts";
import { sqliteFixture } from "../sqliteTesting.ts";
import { imageContentInventory } from "./ImageContentFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("public ProductComputer image-content composition", () => {
  it("reads captured bytes and symlinks through WASI without a machine", async () => {
    await withFixture(async ({ filesystem, syscalls, open, forbidden }) => {
      for (const path of ["etc/link", "etc/config"]) {
        const opened = await open(path);
        expect(opened).toMatchObject({ kind: "return", value: 0 });
        if (opened.kind !== "return") throw new Error("Expected a file descriptor");
        const fdBytes = opened.regions.find((region) => region.pointer === 256)!.bytes;
        const fd = new DataView(fdBytes.buffer, fdBytes.byteOffset, 4).getUint32(0, true);
        const vector = new Uint8Array(8);
        const view = new DataView(vector.buffer);
        view.setUint32(0, 512, true);
        view.setUint32(4, 5, true);
        try {
          const read = await syscalls.call({
            name: "fd_read",
            args: [fd, 128, 1, 256],
            memorySize: 1024,
            regions: [
              { pointer: 128, bytes: vector, direction: "in" },
              { pointer: 256, bytes: new Uint8Array(), direction: "out", length: 4 },
              { pointer: 512, bytes: new Uint8Array(), direction: "out", length: 5 },
            ],
          });
          expect(read).toMatchObject({ kind: "return", value: 0 });
          if (read.kind !== "return") throw new Error("Expected a file read");
          expect(read.regions.find((region) => region.pointer === 512)!.bytes).toEqual(
            Uint8Array.of(0, 255, 128, 10, 65),
          );
        } finally {
          filesystem.close(fd);
        }
      }
      expect(forbidden).not.toHaveBeenCalled();
    });
  });

  it("denies restricted image bytes through WASI and Node opens and reads", async () => {
    await withFixture(async ({ filesystem, open, forbidden }) => {
      const descriptors = [...filesystem.descriptors.entries()].length;
      const denied = await open("etc/private");
      if (denied.kind === "return" && denied.value === 0) {
        const bytes = denied.regions.find((region) => region.pointer === 256)!.bytes;
        filesystem.close(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true));
      }
      expect(denied).toMatchObject({ kind: "return", value: 2 });
      expect([...filesystem.descriptors.entries()]).toHaveLength(descriptors);
      const { fs } = createNodeFs(filesystem);
      expect(() => fs.accessSync("/etc/private", 4)).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(() => fs.openSync("/etc/private", "r")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(() => fs.readFileSync("/etc/private")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      await expect(fs.promises.open("/etc/private", "r")).rejects.toMatchObject({ code: "EACCES" });
      await expect(fs.promises.readFile("/etc/private")).rejects.toMatchObject({ code: "EACCES" });
      expect(await open("etc/private-link")).toMatchObject({ kind: "return", value: 2 });
      await expect(fs.promises.readFile("/etc/private-link")).rejects.toMatchObject({
        code: "EACCES",
      });
      expect([...filesystem.descriptors.entries()]).toHaveLength(descriptors);
      expect(forbidden).not.toHaveBeenCalled();
    });
  });

  it("reads captured bytes through a lower symlink with Node fs", async () => {
    await withFixture(async ({ filesystem, forbidden }) => {
      const { fs } = createNodeFs(filesystem);
      const bytes = Uint8Array.of(0, 255, 128, 10, 65);
      expect(await fs.promises.readFile("/etc/config")).toEqual(Buffer.from(bytes));
      expect(await fs.promises.readFile("/etc/link")).toEqual(Buffer.from(bytes));
      expect(forbidden).not.toHaveBeenCalled();
    });
  });

  it.each([
    { target: "/etc/locked/config", allowed: "/etc/config" },
    { target: "etc/locked/config", allowed: "etc/config" },
  ])(
    "checks parent permissions when reopening an O_PATH symlink to $target",
    async ({ target, allowed }) => {
      await withFixture(async ({ filesystem, forbidden }) => {
        const { fs } = createNodeFs(filesystem);
        fs.symlinkSync(target, "/alias");
        await expect(fs.promises.readFile("/etc/locked/config")).rejects.toMatchObject({
          code: "EACCES",
        });
        await expect(fs.promises.readFile("/alias")).rejects.toMatchObject({ code: "EACCES" });
        const descriptor = fs.openSync(
          "/alias",
          KernelOpenFlags.O_PATH | KernelOpenFlags.O_NOFOLLOW,
        );
        try {
          await expect(fs.promises.readFile(`/proc/self/fd/${descriptor}`)).rejects.toMatchObject({
            code: "EACCES",
          });
        } finally {
          fs.closeSync(descriptor);
        }
        fs.symlinkSync(allowed, "/allowed");
        const readable = fs.openSync(
          "/allowed",
          KernelOpenFlags.O_PATH | KernelOpenFlags.O_NOFOLLOW,
        );
        try {
          expect(await fs.promises.readFile(`/proc/self/fd/${readable}`)).toEqual(
            Buffer.from([0, 255, 128, 10, 65]),
          );
        } finally {
          fs.closeSync(readable);
        }
        expect(forbidden).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps offsets and EOF on async Node file handles", async () => {
    await withFixture(async ({ filesystem, forbidden }) => {
      const { fs } = createNodeFs(filesystem);
      const handle = await fs.promises.open("/etc/link", "r");
      try {
        const first = new Uint8Array(2);
        const rest = new Uint8Array(5);
        expect((await handle.read(first)).bytesRead).toBe(2);
        expect(first).toEqual(Uint8Array.of(0, 255));
        expect((await handle.read(rest)).bytesRead).toBe(3);
        expect(rest.slice(0, 3)).toEqual(Uint8Array.of(128, 10, 65));
        expect((await handle.read(rest)).bytesRead).toBe(0);
      } finally {
        await handle.close();
      }
      expect(forbidden).not.toHaveBeenCalled();
    });
  });

  it("uses captured bytes for Node callbacks, streams and copies", async () => {
    await withFixture(async ({ filesystem, forbidden }) => {
      const { fs } = createNodeFs(filesystem);
      const expected = Uint8Array.of(0, 255, 128, 10, 65);
      const callbackBytes = await new Promise((resolve, reject) => {
        fs.readFile("/etc/link", (error, value) => {
          if (error) reject(error);
          else resolve(value);
        });
      });
      expect(callbackBytes).toEqual(Buffer.from(expected));
      const bytes: number[] = [];
      for await (const chunk of fs.createReadStream("/etc/link")) bytes.push(...chunk);
      expect(Uint8Array.from(bytes)).toEqual(expected);
      await fs.promises.copyFile("/etc/link", "/copy");
      expect(fs.readFileSync("/copy")).toEqual(Buffer.from(expected));
      expect(forbidden).not.toHaveBeenCalled();
    });
  });
});

async function withFixture(
  operation: (fixture: ReturnType<typeof imageContentFixture>) => Promise<void>,
) {
  const fixture = imageContentFixture();
  try {
    await operation(fixture);
  } finally {
    await fixture.close();
  }
}

function imageContentFixture() {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
  });
  const wakes = new KernelWakeRegistry();
  const forbidden = vi.fn(async () => {
    throw new Error("No machine or command is needed to read image content");
  });
  const code = { mainModule: "unused.js", modules: { "unused.js": "export default class {}" } };
  const computer = createProductComputer({
    threadId: "image-content-public-composition",
    filesystem,
    wakes,
    capacity: new ChildWorkerCapacity(2),
    programs: {
      bash: code,
      busyboxCat: code,
      busyboxApplets: code,
      productBusyboxApplets: code,
      ripgrep: code,
      git: code,
      sed: code,
      jq: code,
      coreutils: Object.fromEntries(CHILD_COREUTILS_COMMANDS.map((name) => [name, code])) as Record<
        (typeof CHILD_COREUTILS_COMMANDS)[number],
        typeof code
      >,
    },
    loader: { run: forbidden },
    machineInventory: imageContentInventory(),
    machine: () => ({
      files: {
        current: () => ({ generation: null, generationAbsent: true, pristine: false }),
        markExecuted: forbidden,
        lookup: forbidden,
      },
      spawn: forbidden,
    }),
    signal: new AbortController().signal,
  });
  const syscalls = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  const open = async (path: string) => {
    const name = new TextEncoder().encode(path);
    return syscalls.call({
      name: "path_open",
      args: [3, 1, 128, name.byteLength, 0, 2n, 0n, 0, 256],
      memorySize: 1024,
      regions: [
        { pointer: 128, bytes: name, direction: "in" },
        { pointer: 256, bytes: new Uint8Array(), direction: "out", length: 4 },
      ],
    });
  };
  return {
    filesystem,
    syscalls,
    forbidden,
    open,
    async close() {
      syscalls.close();
      await computer.close();
      wakes.dispose();
      filesystem.dispose();
      database.close();
    },
  };
}
