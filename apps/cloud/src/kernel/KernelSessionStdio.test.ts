import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { createKernelSessionStdio } from "./KernelSessionStdio.ts";
import { createKernelProcessStreams } from "./KernelProcessStreams.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

function fixture() {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const session = createKernelSessionStdio(wakes);
  const files = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
    stdio: session.stdio,
  });
  session.assertBound(files);
  return {
    session,
    files,
    wakes,
    async close() {
      await session.dispose();
      files.dispose();
      database.close();
      wakes.dispose();
    },
  };
}

describe("Kernel session stdio", () => {
  it("binds the exact filesystem and rejects mismatched standard descriptors", async () => {
    const f = fixture();
    try {
      expect(f.session.filesystem).toBe(f.files);
      f.session.assertBound(f.files);
      const wrong = new KernelFileSystem({ mounts: [] });
      try {
        expect(() => f.session.assertBound(wrong)).toThrow("another filesystem");
      } finally {
        wrong.dispose();
      }
      const unbound = createKernelSessionStdio(f.wakes);
      try {
        expect(() => unbound.assertBound(f.files)).toThrow("does not match");
      } finally {
        await unbound.dispose();
      }
    } finally {
      await f.close();
    }
  });

  it("keeps binary input persistent and preserves buffered output after finish and dispose", async () => {
    const f = fixture();
    const payload = Uint8Array.from({ length: 196_613 }, (_, i) => i % 256);
    try {
      const guest = createKernelProcessStreams(f.files);
      const reader = guest.stdin.getReader();
      const input = f.session.stdin.getWriter();
      await input.write(new Uint8Array([0, 255]));
      expect((await reader.read()).value).toEqual(new Uint8Array([0, 255]));
      await input.write(new Uint8Array([128, 7]));
      expect((await reader.read()).value).toEqual(new Uint8Array([128, 7]));
      await input.close();
      expect((await reader.read()).done).toBe(true);
      const received = new Response(f.session.stdout).arrayBuffer();
      const stdout = guest.stdout.getWriter();
      await stdout.write(payload);
      await stdout.close();
      const stderr = guest.stderr.getWriter();
      await stderr.write(new Uint8Array([255, 0, 128]));
      await stderr.close();
      f.session.finish();
      await f.session.dispose();
      expect(new Uint8Array(await received)).toEqual(payload);
      expect(new Uint8Array(await new Response(f.session.stderr).arrayBuffer())).toEqual(
        new Uint8Array([255, 0, 128]),
      );
      expect(f.files.descriptors.has(0)).toBe(true);
      expect(f.wakes.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("stops a blocked guest read and awaits pipe ownership without disposing the filesystem", async () => {
    const f = fixture();
    try {
      const guest = createKernelProcessStreams(f.files);
      const reader = guest.stdin.getReader();
      const reading = reader.read();
      const rejected = expect(reading).rejects.toThrow();
      f.session.stopInput();
      await f.session.dispose();
      await rejected;
      expect(f.files.cwd).toBe("/");
      expect(f.wakes.size).toBe(0);
    } finally {
      await f.close();
    }
  });
});
