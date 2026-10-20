import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { nodeFsWatchFixture } from "./testing/nodeFsWatchFixture.ts";

afterEach(() => vi.useRealTimers());

describe("virtual filesystem watchers", () => {
  it("watches an existing root without throwing and reports actual directory changes", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      const changes: Array<{ current: number | bigint; previous: number | bigint }> = [];
      fixture.fs.watchFile("/", { interval: 10 }, (current, previous) => {
        changes.push({ current: current.mtimeMs, previous: previous.mtimeMs });
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(changes).toEqual([]);
      fixture.fs.mkdirSync("/skills");
      await vi.advanceTimersByTimeAsync(10);
      expect(changes).toHaveLength(1);
      fixture.fs.unwatchFile("/");
      fixture.fs.mkdirSync("/commands");
      await vi.advanceTimersByTimeAsync(20);
      expect(changes).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.close();
    }
  });
  it("reports zero stats for missing files and preserves the last existing stat across recreation", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      const changes: Array<{
        current: import("node:fs").BigIntStats;
        previous: import("node:fs").BigIntStats;
      }> = [];
      fixture.fs.watchFile("/missing", { interval: 10, bigint: true }, (current, previous) => {
        changes.push({
          current: current,
          previous: previous,
        });
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(changes).toHaveLength(1);
      const absent = changes[0]!.current;
      expect([
        absent.size,
        absent.ino,
        absent.mode,
        absent.uid,
        absent.gid,
        absent.mtimeNs,
      ]).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
      expect(absent.mtime.getTime()).toBe(0);
      expect(absent.birthtime.getTime()).toBe(0);
      expect(absent.isFile()).toBe(false);
      expect(absent.isDirectory()).toBe(false);
      fixture.fs.writeFileSync("/missing", "before");
      await vi.advanceTimersByTimeAsync(10);
      expect(changes).toHaveLength(2);
      expect(changes[1]!.current.isFile()).toBe(true);
      expect(changes[1]!.previous.ino).toBe(0n);
      const existing = changes[1]!.current;
      fixture.fs.unlinkSync("/missing");
      await vi.advanceTimersByTimeAsync(10);
      expect(changes[2]!.current.ino).toBe(0n);
      expect(changes[2]!.previous.ino).toBe(existing.ino);
      fixture.fs.writeFileSync("/missing", "after");
      await vi.advanceTimersByTimeAsync(10);
      expect(changes[3]!.current.size).toBe(5n);
      expect(changes[3]!.previous.ino).toBe(existing.ino);
    } finally {
      fixture.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares resolved paths and removes only the requested listener", async () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    try {
      fixture.fs.writeFileSync("/entry", "a");
      const first = vi.fn();
      const second = vi.fn();
      const watcher = fixture.fs.watchFile("entry", { interval: 10 }, first);
      expect(fixture.fs.watchFile(new URL("file:///entry"), { interval: 10 }, second)).toBe(
        watcher,
      );
      fixture.fs.writeFileSync("/entry", "bb");
      await vi.advanceTimersByTimeAsync(10);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      fixture.fs.unwatchFile("./entry", first);
      fixture.fs.writeFileSync("/entry", "ccc");
      await vi.advanceTimersByTimeAsync(10);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);
      fixture.fs.unwatchFile("/entry");
      expect(vi.getTimerCount()).toBe(0);
      fixture.fs.unwatchFile("/not-watched");
    } finally {
      fixture.close();
    }
  });

  it("stops pollers when their filesystem is disposed", () => {
    vi.useFakeTimers();
    const fixture = nodeFsWatchFixture();
    fixture.fs.watchFile("/", { interval: 10 }, () => {});
    expect(vi.getTimerCount()).toBe(1);
    fixture.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
