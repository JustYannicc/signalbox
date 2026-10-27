import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import {
  createKernelSessionStdio,
  type KernelSessionOutputObserver,
  type KernelSessionInputObserver,
} from "./KernelSessionStdio.ts";
import { createKernelProcessStreams } from "./KernelProcessStreams.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

function fixture(observe?: KernelSessionOutputObserver, observeInput?: KernelSessionInputObserver) {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const session = createKernelSessionStdio(wakes, undefined, observe, observeInput);
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
  it("observes only accepted partial writes and never changes SDK output", async () => {
    const observed: number[] = [];
    const f = fixture((fd, bytes) => {
      expect(fd).toBe(1);
      observed.push(...bytes);
      bytes.fill(99);
      throw new Error("An observer is not an output owner");
    });
    try {
      const source = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251);
      // WASI NONBLOCK exposes the exact accepted prefix of a full pipe.
      const count = f.session.stdio[1].write!(source, 4);
      expect(typeof count).toBe("number");
      if (typeof count !== "number") throw new Error("Expected synchronous nonblocking write");
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(source.length);
      expect(Uint8Array.from(observed)).toEqual(source.slice(0, count));
      f.session.finish();
      expect(new Uint8Array(await new Response(f.session.stdout).arrayBuffer())).toEqual(
        source.slice(0, count),
      );
      f.session.assertBound(f.files);
    } finally {
      await f.close();
    }
  });

  it("observes asynchronous accepted writes once while the SDK drains backpressure", async () => {
    const observed: number[] = [];
    const f = fixture(async (fd, bytes) => {
      expect(fd).toBe(2);
      observed.push(...bytes);
      throw new Error("Rejected observation must not fail a successful write");
    });
    try {
      const payload = Uint8Array.from({ length: 196_613 }, (_, i) => i % 251);
      const received = new Response(f.session.stderr).arrayBuffer();
      const writer = createKernelProcessStreams(f.files).stderr.getWriter();
      await writer.write(payload);
      await writer.close();
      f.session.finish();
      expect(new Uint8Array(await received)).toEqual(payload);
      expect(Uint8Array.from(observed)).toEqual(payload);
    } finally {
      await f.close();
    }
  });
  it("observes only bytes consumed by native reads and cannot change the input", async () => {
    const observed: number[] = [];
    const f = fixture(undefined, (bytes) => {
      observed.push(...bytes);
      bytes.fill(99);
      throw new Error("An observer does not own native input");
    });
    try {
      const writer = f.session.stdin.getWriter();
      await writer.write(new Uint8Array([0, 255, 128, 7, 42]));
      expect(observed).toEqual([]);
      const first = new Uint8Array(3);
      expect(await f.session.stdio[0].readInto!(first)).toBe(3);
      expect(first).toEqual(new Uint8Array([0, 255, 128]));
      expect(observed).toEqual([0, 255, 128]);
      const second = new Uint8Array(8).fill(11);
      expect(await f.session.stdio[0].readInto!(second)).toBe(2);
      expect(second).toEqual(new Uint8Array([7, 42, 11, 11, 11, 11, 11, 11]));
      expect(observed).toEqual([0, 255, 128, 7, 42]);
      await writer.close();
      expect(await f.session.stdio[0].readInto!(second)).toBe(0);
      expect(observed).toEqual([0, 255, 128, 7, 42]);
    } finally {
      await f.close();
    }
  });

  it("observes a blocked read once after data arrives without failing input on observer rejection", async () => {
    const observed: number[][] = [];
    const f = fixture(undefined, async (bytes) => {
      observed.push([...bytes]);
      throw new Error("Rejected observation does not cancel a native read");
    });
    try {
      const target = new Uint8Array(8).fill(17);
      const reading = f.session.stdio[0].readInto!(target);
      expect(reading).toBeInstanceOf(Promise);
      expect(observed).toEqual([]);
      const writer = f.session.stdin.getWriter();
      await writer.write(new Uint8Array([255, 0, 128]));
      expect(await reading).toBe(3);
      expect(target).toEqual(new Uint8Array([255, 0, 128, 17, 17, 17, 17, 17]));
      expect(observed).toEqual([[255, 0, 128]]);
      await writer.close();
    } finally {
      await f.close();
    }
  });

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
