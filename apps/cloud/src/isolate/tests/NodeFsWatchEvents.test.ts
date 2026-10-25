import * as NodeBuffer from "node:buffer";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { nodeFsWatchFixture } from "./testing/nodeFsWatchFixture.ts";

afterEach(() => vi.useRealTimers());

describe("virtual filesystem event watchers", () => {
  it("reports file and directory mutations, then detaches on close", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/watched");
      fixture.fs.writeFileSync("/watched/existing.txt", "before");
      const api = { watch: fixture.fs.watch };
      expect(() => api.watch("/watched/missing.txt")).toThrow(
        expect.objectContaining({ code: "ENOENT", syscall: "watch" }),
      );
      const directoryEvents: Array<{ type: string; name: string | NodeBuffer.Buffer | null }> = [];
      const fileEvents: Array<{ type: string; name: string | NodeBuffer.Buffer | null }> = [];
      const directory = api.watch("/watched", (type, name) => {
        directoryEvents.push({ type, name });
      });
      const file = api.watch("/watched/existing.txt", (type, name) => {
        fileEvents.push({ type, name });
      });

      fixture.fs.writeFileSync("/watched/existing.txt", "after");
      await vi.advanceTimersByTimeAsync(100);
      expect(fileEvents).toContainEqual({ type: "change", name: "existing.txt" });

      fixture.fs.writeFileSync("/watched/new.txt", "created");
      await vi.advanceTimersByTimeAsync(100);
      expect(directoryEvents).toContainEqual({ type: "rename", name: "new.txt" });

      const directoryClosed = new Promise<void>((resolve) => directory.once("close", resolve));
      directory.close();
      file.close();
      await directoryClosed;
      const eventCount = directoryEvents.length;
      fixture.fs.writeFileSync("/watched/after-close.txt", "ignored");
      await vi.advanceTimersByTimeAsync(100);
      expect(directoryEvents).toHaveLength(eventCount);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("reports recursive paths with buffer encoding and closes on abort", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/watched");
      const api = { watch: fixture.fs.watch };
      const controller = new AbortController();
      const events: Array<{ type: string; name: string | NodeBuffer.Buffer | null }> = [];
      const watcher = api.watch(
        "/watched",
        { recursive: true, encoding: "buffer", signal: controller.signal },
        (type, name) => events.push({ type, name }),
      );

      fixture.fs.mkdirSync("/watched/nested");
      fixture.fs.writeFileSync("/watched/nested/file.txt", "created");
      await vi.advanceTimersByTimeAsync(100);
      expect(
        events.some(
          (event) =>
            event.type === "rename" &&
            NodeBuffer.Buffer.isBuffer(event.name) &&
            event.name.toString() === "nested/file.txt",
        ),
      ).toBe(true);

      const closed = new Promise<void>((resolve) => watcher.once("close", resolve));
      controller.abort();
      await closed;
      const eventCount = events.length;
      fixture.fs.writeFileSync("/watched/later.txt", "ignored");
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toHaveLength(eventCount);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("resolves symlink traversal before dot-dot in the watched directory", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/first");
      fixture.fs.mkdirSync("/second/nested", { recursive: true });
      fixture.fs.symlinkSync("/second/nested", "/first/link");
      const events: Array<string | NodeBuffer.Buffer | null> = [];
      const watcher = fixture.fs.watch("/first/link/..", (_type, name) => events.push(name));
      fixture.fs.writeFileSync("/second/expected", "yes");
      fixture.fs.writeFileSync("/first/wrong", "no");
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toContain("expected");
      expect(events).not.toContain("wrong");
      watcher.close();
    } finally {
      fixture.close();
    }
  });

  it("returns a closed watcher for an already-aborted signal", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      const api = { watch: fixture.fs.watch };
      const controller = new AbortController();
      controller.abort();
      expect(() => api.watch("/missing", { signal: controller.signal })).toThrow(
        expect.objectContaining({ code: "ENOENT", syscall: "watch" }),
      );
      const watcher = api.watch("/", { signal: controller.signal });
      const closed = new Promise<void>((resolve) => watcher.once("close", resolve));
      await closed;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("stops delivering a polled batch when a listener closes the watcher", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/watched");
      const api = { watch: fixture.fs.watch };
      const names: Array<string | NodeBuffer.Buffer | null> = [];
      let watcher: ReturnType<typeof api.watch>;
      watcher = api.watch("/watched", (_type, name) => {
        names.push(name);
        watcher.close();
      });
      fixture.fs.writeFileSync("/watched/one.txt", "1");
      fixture.fs.writeFileSync("/watched/two.txt", "2");
      await vi.advanceTimersByTimeAsync(100);
      expect(names).toEqual(["one.txt"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("detects replacement of the watched directory root", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/watched");
      const events: Array<string | NodeBuffer.Buffer | null> = [];
      const watcher = fixture.fs.watch("/watched", (_type, name) => events.push(name));
      fixture.fs.rmSync("/watched", { recursive: true });
      fixture.fs.mkdirSync("/watched");
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toContain("watched");
      watcher.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("skips rescans while storage reports no committed change", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/watched");
      const events: Array<string | NodeBuffer.Buffer | null> = [];
      const watcher = fixture.fs.watch("/watched", (_type, name) => events.push(name));
      const readdir = vi.spyOn(fixture.kernelFs, "readdir");

      await vi.advanceTimersByTimeAsync(2_000);
      expect(readdir).not.toHaveBeenCalled();

      fixture.fs.writeFileSync("/watched/new.txt", "created");
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toEqual(["new.txt"]);

      readdir.mockClear();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(readdir).not.toHaveBeenCalled();
      watcher.close();
    } finally {
      fixture.close();
    }
  });

  it("sees changes committed to the database without going through the filesystem", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/watched");
      fixture.fs.writeFileSync("/watched/file.txt", "before");
      const events: Array<{ type: string; name: string | NodeBuffer.Buffer | null }> = [];
      const watcher = fixture.fs.watch("/watched", (type, name) => events.push({ type, name }));
      await vi.advanceTimersByTimeAsync(200);

      // Hydration and revision applies write these rows directly.
      fixture.storage.sql.exec("UPDATE kernel_fs_inode SET mtime_ns = '1' WHERE ino != 1");
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toContainEqual({ type: "change", name: "file.txt" });
      watcher.close();
    } finally {
      fixture.close();
    }
  });

  it("reports writes made by a listener on the next tick", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/watched");
      const names: Array<string | NodeBuffer.Buffer | null> = [];
      const watcher = fixture.fs.watch("/watched", (_type, name) => {
        names.push(name);
        if (name === "first.txt") fixture.fs.writeFileSync("/watched/second.txt", "2");
      });
      fixture.fs.writeFileSync("/watched/first.txt", "1");
      await vi.advanceTimersByTimeAsync(100);
      expect(names).toEqual(["first.txt"]);
      await vi.advanceTimersByTimeAsync(100);
      expect(names).toEqual(["first.txt", "second.txt"]);
      watcher.close();
    } finally {
      fixture.close();
    }
  });

  it("keeps rescanning while a byte view can change sizes without a storage write", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.writeFileSync("/file", "data");
      let size = 4n;
      fixture.kernelFs.setFileBytes({
        kind: "view",
        view: {
          completion: "sync",
          storage: fixture.mounted,
          bind: (inode) => ({
            stat: () => ({ ...fixture.mounted.stat(inode), size }),
            readInto: () => 0,
            write: () => 0,
            append: () => ({ offset: size, bytesWritten: 0 }),
            truncate: (next) => {
              size = next;
            },
            sync: () => {},
            release: () => {},
          }),
        },
      });
      expect(fixture.kernelFs.changeGeneration()).toBeUndefined();
      const events: Array<string | NodeBuffer.Buffer | null> = [];
      const watcher = fixture.fs.watch("/file", (_type, name) => events.push(name));
      await vi.advanceTimersByTimeAsync(200);

      size = 2n;
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toEqual(["file"]);
      watcher.close();
    } finally {
      fixture.close();
    }
  });

  it("keeps rescanning descriptor-alias paths, which change when descriptors close", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/proc/self/fd", { recursive: true });
      fixture.fs.writeFileSync("/file", "data");
      const fd = fixture.kernelFs.open("/file", KernelOpenFlags.O_RDONLY);
      // A relative path skips alias resolution, so this creates a real entry under the alias.
      fixture.fs.writeFileSync(`proc/self/fd/${fd}`, "");
      const events: Array<{ type: string; name: string | NodeBuffer.Buffer | null }> = [];
      const watcher = fixture.fs.watch("/proc/self/fd", (type, name) =>
        events.push({ type, name }),
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(events).toEqual([]);

      fixture.kernelFs.close(fd);
      await vi.advanceTimersByTimeAsync(100);
      expect(events.map((event) => event.name)).toContain(String(fd));
      watcher.close();
    } finally {
      fixture.close();
    }
  });

  it("keeps rescanning every tick when a mount cannot report changes", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture({ changeGeneration: false });
    try {
      fixture.fs.mkdirSync("/watched");
      expect(fixture.kernelFs.changeGeneration()).toBeUndefined();
      const events: Array<string | NodeBuffer.Buffer | null> = [];
      const watcher = fixture.fs.watch("/watched", (_type, name) => events.push(name));
      const readdir = vi.spyOn(fixture.kernelFs, "readdir");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(readdir).toHaveBeenCalledTimes(10);
      fixture.fs.writeFileSync("/watched/new.txt", "created");
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toEqual(["new.txt"]);
      watcher.close();
    } finally {
      fixture.close();
    }
  });
});
