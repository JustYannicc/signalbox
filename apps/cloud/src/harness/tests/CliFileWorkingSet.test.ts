import { describe, expect, it } from "@effect/vitest";
import { CliFileWorkingSet } from "../CliFileWorkingSet.ts";
import type { KernelStat } from "../../kernel/KernelFileSystem.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../kernel/KernelSyscallPort.ts";

function metadata(path: string, size: number) {
  const stat: KernelStat = {
    type: "file",
    size: BigInt(size),
    nlink: 1n,
    atimeNs: 0n,
    mtimeNs: 0n,
    ctimeNs: 0n,
    ino: 1n,
    dev: 1n,
  };
  return { path, stat };
}
function workingSet(byteLimit: number) {
  return new CliFileWorkingSet({ byteLimit, metadataLimit: 16, pathByteLimit: 128 });
}

describe("CLI synchronous file working set", () => {
  it("prefetches only requested content in bounded syscall ranges", async () => {
    const size = KERNEL_SYSCALL_MAX_IO_BYTES + 7;
    const files = workingSet(size);
    files.replaceMetadata(4, [metadata("/sync", size), metadata("/async", 4)]);
    const ranges: number[][] = [];
    await files.prefetch("/sync", async (offset, length, revision) => {
      ranges.push([offset, length, revision]);
      return new Uint8Array(length).fill(9);
    });
    expect(ranges).toEqual([
      [0, KERNEL_SYSCALL_MAX_IO_BYTES, 4],
      [KERNEL_SYSCALL_MAX_IO_BYTES, 7, 4],
    ]);
    expect(files.bytes).toBe(size);
    expect(() => files.content("/async")).toThrow("not prefetched");
    const target = new Uint8Array(10);
    expect(files.copyInto("/sync", target, size - 5)).toBe(5);
    expect([...target]).toEqual([9, 9, 9, 9, 9, 0, 0, 0, 0, 0]);
    await files.close();
    expect(files.bytes).toBe(0);
  });

  it("evicts unused bytes and refuses to evict an in-use synchronous read", async () => {
    const files = workingSet(4);
    files.replaceMetadata(1, [metadata("/a", 4), metadata("/b", 4)]);
    await files.prefetch("/a", async () => new Uint8Array([1, 2, 3, 4]));
    const release = files.pin("/a");
    await expect(files.prefetch("/b", async () => new Uint8Array(4))).rejects.toMatchObject({
      code: "CLI_FS_WORKING_SET_LIMIT",
    });
    expect(files.content("/a")).toEqual(new Uint8Array([1, 2, 3, 4]));
    release();
    await files.prefetch("/b", async () => new Uint8Array(4));
    expect(() => files.content("/a")).toThrow("not prefetched");
    expect(files.bytes).toBe(4);
    await files.close();
  });

  it("preserves the previous value when a replacement would exceed the byte limit", async () => {
    const files = workingSet(6);
    files.replaceMetadata(1, [metadata("/a", 3)]);
    await files.prefetch("/a", async () => new Uint8Array([1, 2, 3]));
    expect(() => files.replaceContent("/a", new Uint8Array(4))).toThrow("working set needs");
    expect(files.content("/a")).toEqual(new Uint8Array([1, 2, 3]));
    expect(files.bytes).toBe(3);
    await files.close();
  });

  it("does not publish an old prefetch after a revision change", async () => {
    const files = workingSet(4);
    files.replaceMetadata(1, [metadata("/a", 4)]);
    const read = Promise.withResolvers<Uint8Array>();
    const pending = files.prefetch("/a", () => read.promise);
    files.replaceMetadata(2, [metadata("/a", 4)]);
    read.resolve(new Uint8Array(4));
    await expect(pending).rejects.toMatchObject({ code: "ESTALE" });
    expect(() => files.content("/a")).toThrow("not prefetched");
    expect(files.bytes).toBe(0);
    await files.close();
  });

  it("commits writes in order and waits for their physical completion at a barrier", async () => {
    const files = workingSet(8);
    const first = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const commits: number[] = [];
    files.writes.enqueue(4, async () => {
      commits.push(1);
      entered.resolve();
      await first.promise;
    });
    files.writes.enqueue(4, async () => {
      commits.push(2);
    });
    const flushed = files.writes.flush();
    await entered.promise;
    expect(commits).toEqual([1]);
    expect(files.bytes).toBe(8);
    first.resolve();
    await flushed;
    expect(commits).toEqual([1, 2]);
    expect(files.bytes).toBe(0);
    await files.close();
  });

  it("retains a failed write and prevents dependent work from accepting speculative bytes", async () => {
    const files = workingSet(8);
    files.replaceMetadata(1, [metadata("/a", 1)]);
    const failure = Object.assign(new Error("Computer write failed"), { code: "EROFS" });
    let skipped = false;
    files.writes.enqueue(4, async () => {
      throw failure;
    });
    files.writes.enqueue(4, async () => {
      skipped = true;
    });
    await expect(files.writes.flush()).rejects.toBe(failure);
    expect(skipped).toBe(false);
    expect(files.bytes).toBe(0);
    expect(() => files.metadata("/a")).toThrow("Computer write failed");
    await expect(files.close()).rejects.toBe(failure);
  });

  it("does not share bytes or metadata between CLI sessions", async () => {
    const first = workingSet(8);
    const second = workingSet(8);
    const entry = metadata("/a", 1);
    first.replaceMetadata(1, [entry]);
    second.replaceMetadata(1, [entry]);
    await first.prefetch("/a", async () => new Uint8Array([7]));
    const returned = first.content("/a");
    returned[0] = 9;
    expect(first.content("/a")).toEqual(new Uint8Array([7]));
    expect(() => second.content("/a")).toThrow("not prefetched");
    expect(second.bytes).toBe(0);
    await first.close();
    await second.close();
  });
});
