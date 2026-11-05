// @effect-diagnostics nodeBuiltinImport:off - hashes controlled executable bytes.
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { createKernelExecutableNamespace } from "./KernelExecutableNamespace.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

function fixture() {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
  });
  const controller = new AbortController();
  const namespace = createKernelExecutableNamespace({ filesystem, signal: controller.signal });
  return {
    filesystem,
    controller,
    namespace,
    write(bytes: Uint8Array) {
      const fd = filesystem.open(
        "/tool",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
        0o755,
      );
      try {
        filesystem.write(fd, bytes, 0n);
      } finally {
        filesystem.close(fd);
      }
    },
    async close() {
      await namespace.close();
      filesystem.dispose();
      database.close();
    },
  };
}

it("verifies bounded chunks against the same live kernel used by synchronous reads", async () => {
  const f = fixture();
  const bytes = new Uint8Array(3 * 64 * 1024 + 7).fill(42);
  f.write(bytes);
  const artifact = {
    bytes: bytes.byteLength,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  };
  const reads = vi.spyOn(f.filesystem, "readAsync");
  const descriptors = [...f.filesystem.descriptors.entries()].map(([fd]) => fd);
  try {
    expect(await f.namespace.inspect("/tool", artifact)).toEqual({
      type: "file",
      lower: false,
      matchesArtifact: true,
    });
    expect(reads.mock.calls.map(([, target]) => target.byteLength)).toEqual([
      64 * 1024,
      64 * 1024,
      64 * 1024,
      7,
    ]);
    expect([...f.filesystem.descriptors.entries()].map(([fd]) => fd)).toEqual(descriptors);
    bytes[0] = 43;
    f.write(bytes);
    expect(await f.namespace.inspect("/tool", artifact)).toMatchObject({ matchesArtifact: false });
  } finally {
    await f.close();
  }
});

it("closes the borrowed descriptor when verification is cancelled", async () => {
  const f = fixture();
  const bytes = new Uint8Array(64 * 1024 + 1);
  f.write(bytes);
  const originalRead = f.filesystem.readAsync.bind(f.filesystem);
  const reason = new Error("Command cancelled");
  vi.spyOn(f.filesystem, "readAsync").mockImplementationOnce(async (...args) => {
    const read = await originalRead(...args);
    f.controller.abort(reason);
    return read;
  });
  const descriptors = [...f.filesystem.descriptors.entries()].map(([fd]) => fd);
  try {
    await expect(
      f.namespace.inspect("/tool", {
        bytes: bytes.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      }),
    ).rejects.toBe(reason);
    expect([...f.filesystem.descriptors.entries()].map(([fd]) => fd)).toEqual(descriptors);
  } finally {
    await f.close();
  }
});

it("revokes late inspection calls without closing the authoritative filesystem", async () => {
  const f = fixture();
  f.write(new Uint8Array([42]));
  try {
    await f.namespace.close();
    await expect(f.namespace.inspect("/tool")).rejects.toMatchObject({ code: "EBADF" });
    expect(f.filesystem.stat("/tool").size).toBe(1n);
  } finally {
    await f.close();
  }
});
