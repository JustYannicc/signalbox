import { describe, expect, it } from "vite-plus/test";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createNodeFs } from "../NodeFs.ts";
import { nodeFsPosixFixture } from "./helpers/NodeFsPosixFixture.ts";

describe("Node fs POSIX stats", () => {
  it("includes stored permission bits and ownership in number and bigint stats", () => {
    const fixture = nodeFsPosixFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.writeFileSync("/owned", "data");
      fixture.kernelFs.chmod("/owned", 0o640);

      const numeric = fs.statSync("/owned");
      expect(numeric.mode).toBe(0o100640);
      expect(numeric.uid).toBe(1000);
      expect(numeric.gid).toBe(1000);

      const bigint = fs.statSync("/owned", { bigint: true });
      expect(bigint.mode).toBe(0o100640n);
      expect(bigint.uid).toBe(1000n);
      expect(bigint.gid).toBe(1000n);
    } finally {
      fixture.close();
    }
  });

  it("uses target metadata for stat and symlink metadata for lstat", () => {
    const fixture = nodeFsPosixFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.writeFileSync("/target", "data");
      fixture.kernelFs.chmod("/target", 0o640);
      fs.symlinkSync("target", "/link");

      const target = fs.statSync("/link");
      expect(target.mode).toBe(0o100640);
      expect(target.uid).toBe(1000);
      expect(target.gid).toBe(1000);

      const link = fs.lstatSync("/link");
      expect(link.mode).toBe(0o120777);
      expect(link.uid).toBe(1000);
      expect(link.gid).toBe(1000);

      fs.mkdirSync("/directory");
      expect(fs.statSync("/directory").mode).toBe(0o040755);
    } finally {
      fixture.close();
    }
  });

  it("reads retained descriptor metadata after unlink", () => {
    const fixture = nodeFsPosixFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.writeFileSync("/retained", "data");
      fixture.kernelFs.chmod("/retained", 0o601);
      const fd = fs.openSync("/retained", "r");
      fs.unlinkSync("/retained");

      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        expect(stat.mode).toBe(0o100601n);
        expect(stat.uid).toBe(1000n);
        expect(stat.gid).toBe(1000n);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fixture.close();
    }
  });

  it("keeps unknown metadata unknown for uninitialized, virtual, and proc magic paths", () => {
    const fixture = nodeFsPosixFixture(false);
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.writeFileSync("/legacy", "data");
      const fd = fs.openSync("/legacy", "r");

      expect(fs.statSync("/legacy")).toMatchObject({
        mode: 0o100000,
        uid: -1,
        gid: -1,
      });
      expect(fs.fstatSync(fd)).toMatchObject({ mode: 0o100000, uid: -1, gid: -1 });
      expect(fs.statSync("/dev/null")).toMatchObject({ mode: 0o020000, uid: -1, gid: -1 });
      expect(fs.lstatSync(`/proc/self/fd/${fd}`)).toMatchObject({
        mode: 0o120000,
        uid: -1,
        gid: -1,
      });
      fs.closeSync(fd);
    } finally {
      fixture.close();
    }
  });

  it("keeps inode and permissions from one snapshot across an async rename", async () => {
    const fixture = nodeFsPosixFixture();
    try {
      const writer = createNodeFs(fixture.kernelFs).fs;
      writer.writeFileSync("/source", "original", { mode: 0o640 });
      writer.writeFileSync("/replacement", "different", { mode: 0o600 });
      const original = fixture.kernelFs.stat("/source");
      let replaced = false;
      const fs = createNodeFs(fixture.kernelFs, undefined, async (operation) => {
        const value = operation();
        if (!replaced) {
          replaced = true;
          writer.renameSync("/source", "/retained");
          writer.renameSync("/replacement", "/source");
        }
        return value;
      }).fs;
      const stat = await fs.promises.stat("/source");
      expect(stat.ino).toBe(Number(original.ino));
      expect(stat.mode).toBe(0o100640);
      expect(writer.statSync("/source").mode).toBe(0o100600);
    } finally {
      fixture.close();
    }
  });

  it("does not hide non-ENOTSUP errors from POSIX metadata storage", () => {
    const fixture = nodeFsPosixFixture();
    const failure = Object.assign(new Error("POSIX metadata read failed"), { code: "EIO" });
    const posix = new Proxy(fixture.storage.posix, {
      get(target, property, receiver) {
        if (property === "get")
          return () => {
            throw failure;
          };
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const storage = { ...fixture.storage, posix };
    const kernelFs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      cwd: "/",
      posix: {
        credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
        umask: 0o022,
      },
    });
    try {
      const { fs } = createNodeFs(kernelFs);
      fs.writeFileSync("/broken-metadata", "data");

      expect(() => fs.statSync("/broken-metadata")).toThrow(
        expect.objectContaining({ code: "EIO", syscall: "stat", path: "/broken-metadata" }),
      );
    } finally {
      kernelFs.dispose();
      fixture.close();
    }
  });
});
