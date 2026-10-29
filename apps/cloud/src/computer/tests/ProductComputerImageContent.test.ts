import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { withImageContentFixture } from "./ProductComputerImageContentFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("public ProductComputer image-content composition", () => {
  it("reads captured bytes and symlinks through WASI without a machine", async () => {
    await withImageContentFixture(async ({ filesystem, syscalls, open, forbidden }) => {
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
    await withImageContentFixture(async ({ filesystem, open, forbidden }) => {
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
    await withImageContentFixture(async ({ filesystem, forbidden }) => {
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
      await withImageContentFixture(async ({ filesystem, forbidden }) => {
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
    await withImageContentFixture(async ({ filesystem, forbidden }) => {
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
    await withImageContentFixture(async ({ filesystem, forbidden }) => {
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
