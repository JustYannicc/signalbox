import { describe, expect, it } from "@effect/vitest";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createNodeFs } from "../NodeFs.ts";
import { nodeFsPosixFixture } from "./helpers/NodeFsPosixFixture.ts";

describe("Node fs canonical permissions", () => {
  it("creates directories with mode and the live umask without changing existing directories", async () => {
    const test = nodeFsPosixFixture();
    const fs = createNodeFs(test.kernelFs).fs;
    const previousUmask = test.kernelFs.setUmask(0o027);
    try {
      fs.mkdirSync("/default-mode");
      fs.mkdirSync("/explicit-mode", 0o777);
      const created = await fs.promises.mkdir("/nested/parent/leaf", {
        recursive: true,
        mode: 0o777,
      });
      fs.mkdirSync("/existing", 0o700);
      await fs.promises.mkdir("/existing", { recursive: true, mode: 0o777 });

      expect(fs.statSync("/default-mode").mode & 0o7777).toBe(0o750);
      expect(fs.statSync("/explicit-mode").mode & 0o7777).toBe(0o750);
      expect(created).toBe("/nested");
      for (const path of ["/nested", "/nested/parent", "/nested/parent/leaf"])
        expect(fs.statSync(path).mode & 0o7777).toBe(0o750);
      expect(fs.statSync("/existing").mode & 0o7777).toBe(0o700);

      expect(() => fs.mkdirSync("/invalid/child", { recursive: true, mode: -1 })).toThrow(
        expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
      );
      expect(fs.existsSync("/invalid")).toBe(false);
    } finally {
      test.kernelFs.setUmask(previousUmask);
      test.close();
    }
  });

  it("changes path and descriptor permissions through sync, promise, callback and handle APIs", async () => {
    const test = nodeFsPosixFixture();
    const root = new KernelFileSystem({
      mounts: [{ path: "/", storage: test.storage }],
      posix: {
        credentials: { uid: 0, gid: 0, euid: 0, egid: 0 },
        umask: 0o022,
      },
    });
    const fs = createNodeFs(root).fs;
    try {
      fs.writeFileSync("/file", "bytes");
      fs.chmodSync("/file", "0640");
      expect(fs.statSync("/file").mode & 0o7777).toBe(0o640);
      await fs.promises.chmod("/file", 0o600);
      expect(fs.statSync("/file").mode & 0o7777).toBe(0o600);
      await new Promise<void>((resolve, reject) => {
        fs.chmod("/file", 0o644, (error) => (error ? reject(error) : resolve()));
      });
      expect(fs.statSync("/file").mode & 0o7777).toBe(0o644);

      const fd = fs.openSync("/file", "r");
      try {
        fs.fchmodSync(fd, 0o640);
        expect(fs.fstatSync(fd).mode & 0o7777).toBe(0o640);
        await new Promise<void>((resolve, reject) => {
          fs.fchmod(fd, 0o620, (error) => (error ? reject(error) : resolve()));
        });
        expect(fs.fstatSync(fd).mode & 0o7777).toBe(0o620);
      } finally {
        fs.closeSync(fd);
      }

      fs.chownSync("/file", 2000, 2000);
      expect(fs.statSync("/file")).toMatchObject({ uid: 2000, gid: 2000 });
      await fs.promises.chown("/file", 3000, 3000);
      expect(fs.statSync("/file")).toMatchObject({ uid: 3000, gid: 3000 });
      await new Promise<void>((resolve, reject) => {
        fs.chown("/file", 4000, 4000, (error) => (error ? reject(error) : resolve()));
      });
      expect(fs.statSync("/file")).toMatchObject({ uid: 4000, gid: 4000 });

      const descriptor = fs.openSync("/file", "r");
      try {
        fs.fchownSync(descriptor, 5000, 5000);
        expect(fs.fstatSync(descriptor)).toMatchObject({ uid: 5000, gid: 5000 });
        await new Promise<void>((resolve, reject) => {
          fs.fchown(descriptor, 6000, 6000, (error) => (error ? reject(error) : resolve()));
        });
        expect(fs.fstatSync(descriptor)).toMatchObject({ uid: 6000, gid: 6000 });
      } finally {
        fs.closeSync(descriptor);
      }

      const handle = await fs.promises.open("/file", "r");
      try {
        await handle.chown(7000, 7000);
        expect(await handle.stat()).toMatchObject({ uid: 7000, gid: 7000 });
      } finally {
        await handle.close();
      }
    } finally {
      root.dispose();
      test.close();
    }
  });

  it("preserves original permission bits during the official atomic-edit sequence", async () => {
    const test = nodeFsPosixFixture();
    const fs = createNodeFs(test.kernelFs).fs;
    try {
      fs.mkdirSync("/work");
      fs.writeFileSync("/work/source.txt", "before", { mode: 0o640 });
      const original = await fs.promises.lstat("/work/source.txt");
      if (typeof original.mode !== "number") throw new Error("Expected numeric mode");
      const directory = await fs.promises.open("/work", 2048);
      try {
        const temp = `/proc/self/fd/${directory.fd}/source.txt.tmp`;
        const handle = await fs.promises.open(temp, 131265, 0o600);
        try {
          await handle.writeFile("after");
          await handle.chmod(original.mode);
          expect(test.kernelFs.getPosixMetadataForFd(handle.fd)).toMatchObject({
            mode: 0o640,
            uid: 1000,
            gid: 1000,
          });
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.promises.rename(temp, "/work/source.txt");
        expect(fs.readFileSync("/work/source.txt", "utf8")).toBe("after");
        expect(test.kernelFs.getPosixMetadata("/work/source.txt").mode).toBe(0o640);
      } finally {
        await directory.close();
      }
    } finally {
      test.close();
    }
  });

  it("masks Node stat type bits and honors FileHandle close ownership", async () => {
    const test = nodeFsPosixFixture();
    const fs = createNodeFs(test.kernelFs).fs;
    try {
      const handle = await fs.promises.open("/file", "w+");
      await handle.chmod(0o100640);
      expect(test.kernelFs.getPosixMetadataForFd(handle.fd).mode).toBe(0o640);
      await handle.chmod("0600");
      for (const mode of [-1, 0x1_0000_0000, 1.5]) {
        await expect(handle.chmod(mode)).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
      }
      expect(test.kernelFs.getPosixMetadataForFd(handle.fd).mode).toBe(0o600);
      await handle.close();
      const next = await fs.promises.open("/other", "w+");
      try {
        await expect(handle.chmod(0o777)).rejects.toMatchObject({ code: "EBADF" });
        expect(test.kernelFs.getPosixMetadataForFd(next.fd).mode).toBe(0o644);
      } finally {
        await next.close();
      }
    } finally {
      test.close();
    }
  });

  it("drains chmod before closing its descriptor", async () => {
    const test = nodeFsPosixFixture();
    const gate = Promise.withResolvers<void>();
    let blocked = false;
    const fs = createNodeFs(test.kernelFs, undefined, async (operation) => {
      if (blocked) await gate.promise;
      return operation();
    }).fs;
    try {
      const handle = await fs.promises.open("/file", "w+");
      blocked = true;
      const changing = handle.chmod(0o600);
      const closing = handle.close();
      await expect(handle.chmod(0o777)).rejects.toMatchObject({ code: "EBADF" });
      gate.resolve();
      await changing;
      await closing;
      expect(test.kernelFs.getPosixMetadata("/file").mode).toBe(0o600);
      expect(() => test.kernelFs.fstat(handle.fd)).toThrow(
        expect.objectContaining({ code: "EBADF" }),
      );
    } finally {
      gate.resolve();
      test.close();
    }
  });

  it("checks proc-fd execute access through promises, callbacks and sync calls", async () => {
    const test = nodeFsPosixFixture();
    const fs = createNodeFs(test.kernelFs).fs;
    try {
      fs.mkdirSync("/work");
      const handle = await fs.promises.open("/work", 2048);
      const path = `/proc/self/fd/${handle.fd}`;
      const callback = (mode: number) =>
        new Promise<unknown>((resolve) => fs.access(path, mode, (error) => resolve(error)));
      try {
        await fs.promises.access(path, 1);
        expect(() => fs.accessSync(path, 1)).not.toThrow();
        expect(await callback(1)).toBeNull();
        test.kernelFs.chmod("/work", 0);
        await expect(fs.promises.access(path, 1)).rejects.toMatchObject({
          code: "EACCES",
          syscall: "access",
          path,
        });
        expect(() => fs.accessSync(path, 1)).toThrow(expect.objectContaining({ code: "EACCES" }));
        expect(await callback(1)).toMatchObject({ code: "EACCES" });
        await fs.promises.access(path, 0);
      } finally {
        await handle.close();
      }
      await expect(fs.promises.access(path, 1)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      test.close();
    }
  });

  it("uses real credentials for access instead of effective ownership", async () => {
    const test = nodeFsPosixFixture();
    const primary = createNodeFs(test.kernelFs).fs;
    primary.writeFileSync("/private", "bytes", { mode: 0o600 });
    const other = new KernelFileSystem({
      mounts: [{ path: "/", storage: test.storage }],
      posix: {
        credentials: { uid: 2000, gid: 2000, euid: 1000, egid: 1000 },
        umask: 0o022,
      },
    });
    try {
      const fs = createNodeFs(other).fs;
      await expect(fs.promises.access("/private", 4)).rejects.toMatchObject({ code: "EACCES" });
      await fs.promises.access("/private", 0);
    } finally {
      other.dispose();
      test.close();
    }
  });

  it("preserves owner, readonly mount, missing policy and missing-path failures", async () => {
    const test = nodeFsPosixFixture();
    const fs = createNodeFs(test.kernelFs).fs;
    try {
      fs.writeFileSync("/file", "bytes");
      const other = new KernelFileSystem({
        mounts: [{ path: "/", storage: test.storage }],
        posix: {
          credentials: { uid: 2000, gid: 2000, euid: 2000, egid: 2000 },
          umask: 0o022,
        },
      });
      const policy = test.kernelFs.posixPolicy;
      if (policy === undefined) throw new Error("Missing fixture POSIX policy");
      const readonly = new KernelFileSystem({
        mounts: [{ path: "/", storage: test.storage, readOnly: true }],
        posix: policy,
      });
      try {
        const otherHandle = await createNodeFs(other).fs.promises.open("/file", "r+");
        try {
          await expect(otherHandle.chmod(0o777)).rejects.toMatchObject({
            code: "EPERM",
            syscall: "fchmod",
          });
        } finally {
          await otherHandle.close();
        }
        const readonlyHandle = await createNodeFs(readonly).fs.promises.open("/file", "r");
        try {
          await expect(readonlyHandle.chmod(0o777)).rejects.toMatchObject({ code: "EROFS" });
        } finally {
          await readonlyHandle.close();
        }
      } finally {
        other.dispose();
        readonly.dispose();
      }
      await expect(fs.promises.access("/missing", 1)).rejects.toMatchObject({ code: "ENOENT" });
      expect(test.kernelFs.getPosixMetadata("/file").mode).toBe(0o644);
    } finally {
      test.close();
    }
    const plain = nodeFsPosixFixture(false);
    const plainFs = createNodeFs(plain.kernelFs).fs;
    try {
      const handle = await plainFs.promises.open("/file", "w+");
      try {
        await expect(handle.chmod(0o600)).rejects.toMatchObject({ code: "ENOTSUP" });
      } finally {
        await handle.close();
      }
      await expect(plainFs.promises.access("/file", 1)).rejects.toMatchObject({ code: "ENOTSUP" });
      await expect(plainFs.promises.chmod("/file", 0o600)).rejects.toMatchObject({
        code: "ENOTSUP",
      });
      await expect(plainFs.promises.chown("/file", 1000, 1000)).rejects.toMatchObject({
        code: "ENOTSUP",
      });
      await expect(plainFs.promises.mkdir("/mode", { mode: 0o700 })).rejects.toMatchObject({
        code: "ENOTSUP",
      });
      expect(plainFs.existsSync("/mode")).toBe(false);
      expect(() => plainFs.statfsSync("/file")).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      await expect(plainFs.promises.statfs("/file")).rejects.toMatchObject({ code: "ENOTSUP" });
    } finally {
      plain.close();
    }
  });
});
