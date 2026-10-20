import * as NodeBuffer from "node:buffer";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { nodeFsWatchFixture } from "./testing/nodeFsWatchFixture.ts";

afterEach(() => vi.useRealTimers());

describe("virtual filesystem event watchers", () => {
  it("reports file and directory mutations, then detaches on close", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/watched");
      fixture.fs.writeFileSync("/watched/existing.txt", "before");
      const api = { watch: fixture.fs.watch, watchPromises: fixture.fs.promises.watch };
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
      const api = { watch: fixture.fs.watch, watchPromises: fixture.fs.promises.watch };
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
      const api = { watch: fixture.fs.watch, watchPromises: fixture.fs.promises.watch };
      const controller = new AbortController();
      controller.abort();
      const watcher = api.watch("/missing", { signal: controller.signal });
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
      const api = { watch: fixture.fs.watch, watchPromises: fixture.fs.promises.watch };
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

  it("detects directory-root replacement and delivers pending events before a zero queue limit", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fixture.fs.mkdirSync("/watched");
      const api = { watch: fixture.fs.watch, watchPromises: fixture.fs.promises.watch };
      const rootEvents: Array<{ type: string; name: string | NodeBuffer.Buffer | null }> = [];
      const directory = api.watch("/watched", (type, name) => rootEvents.push({ type, name }));
      fixture.fs.rmSync("/watched", { recursive: true });
      fixture.fs.mkdirSync("/watched");
      await vi.advanceTimersByTimeAsync(100);
      expect(rootEvents).toContainEqual({ type: "rename", name: "watched" });
      directory.close();

      const iterator = api.watchPromises("/watched", { maxQueue: 0, overflow: "ignore" });
      const pending = iterator.next();
      fixture.fs.writeFileSync("/watched/one.txt", "1");
      fixture.fs.writeFileSync("/watched/two.txt", "2");
      fixture.fs.writeFileSync("/watched/three.txt", "3");
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toMatchObject({
        done: false,
        value: { eventType: "rename", filename: "one.txt" },
      });
      expect(warn).toHaveBeenCalledTimes(1);
      await iterator.return();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      warn.mockRestore();
      fixture.close();
    }
  });

  it("bounds the promises queue and cleans up on return, throw, and abort", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.mkdirSync("/watched");
      const api = { watch: fixture.fs.watch, watchPromises: fixture.fs.promises.watch };
      const iterator = api.watchPromises("/watched", { maxQueue: 1, overflow: "error" });
      const first = iterator.next();
      fixture.fs.writeFileSync("/watched/one.txt", "1");
      fixture.fs.writeFileSync("/watched/two.txt", "2");
      fixture.fs.writeFileSync("/watched/three.txt", "3");
      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toMatchObject({ done: false });
      await expect(iterator.next()).rejects.toMatchObject({ code: "ERR_FS_WATCH_QUEUE_OVERFLOW" });
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      expect(vi.getTimerCount()).toBe(0);

      const returned = api.watchPromises("/watched");
      await expect(returned.return()).resolves.toMatchObject({ done: true });
      expect(vi.getTimerCount()).toBe(0);

      const pendingReturn = api.watchPromises("/watched");
      const pendingNext = pendingReturn.next();
      await expect(pendingReturn.return()).resolves.toMatchObject({ done: true });
      await expect(pendingNext).resolves.toMatchObject({ done: true });
      expect(vi.getTimerCount()).toBe(0);

      const thrown = api.watchPromises("/watched");
      await expect(thrown.throw(new Error("stop"))).rejects.toThrow("stop");
      expect(vi.getTimerCount()).toBe(0);

      const controller = new AbortController();
      const aborted = api.watchPromises("/watched", { signal: controller.signal });
      const next = aborted.next();
      controller.abort();
      await expect(next).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.close();
    }
  });
});
