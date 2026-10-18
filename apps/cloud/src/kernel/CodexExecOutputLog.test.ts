import { describe, expect, it, vi } from "vitest";
import { CodexExecOutputLog } from "./CodexExecOutputLog.ts";

describe("CodexExecOutputLog", () => {
  it("replays output around exit and close on one shared sequence", async () => {
    const log = new CodexExecOutputLog();
    expect(log.append("stdout", new TextEncoder().encode("first"))).toEqual({
      seq: 1,
      stream: "stdout",
      chunk: "Zmlyc3Q=",
    });
    expect(log.exited(17)).toEqual({ seq: 2, exitCode: 17 });
    expect(log.append("stderr", new TextEncoder().encode("tail"))).toEqual({
      seq: 3,
      stream: "stderr",
      chunk: "dGFpbA==",
    });
    expect(log.close()).toEqual({ seq: 4 });

    await expect(log.read()).resolves.toEqual({
      chunks: [
        { seq: 1, stream: "stdout", chunk: "Zmlyc3Q=" },
        { seq: 3, stream: "stderr", chunk: "dGFpbA==" },
      ],
      nextSeq: 5,
      exited: true,
      exitCode: 17,
      closed: true,
      failure: null,
      sandboxDenied: false,
    });
    await expect(log.read({ afterSeq: 3 })).resolves.toMatchObject({
      chunks: [],
      nextSeq: 5,
      exited: true,
      closed: true,
    });
  });

  it("matches Codex byte-budget pagination, including an oversized first chunk", async () => {
    const log = new CodexExecOutputLog();
    log.append("stdout", Uint8Array.of(1, 2, 3));
    log.append("pty", Uint8Array.of(4, 5));
    log.exited(0);

    await expect(log.read({ maxBytes: 1 })).resolves.toMatchObject({
      chunks: [{ seq: 1, stream: "stdout", chunk: "AQID" }],
      nextSeq: 2,
      exited: true,
    });
    await expect(log.read({ afterSeq: 1, maxBytes: 2 })).resolves.toMatchObject({
      chunks: [{ seq: 2, stream: "pty", chunk: "BAU=" }],
      nextSeq: 3,
      exited: true,
    });
    await expect(log.read({ afterSeq: 2, maxBytes: 2 })).resolves.toMatchObject({
      chunks: [],
      nextSeq: 4,
      exited: true,
      exitCode: 0,
    });
  });

  it("retains only the newest bytes and chunks and owns appended bytes", async () => {
    const source = Uint8Array.of(97, 98);
    const copyLog = new CodexExecOutputLog();
    copyLog.append("stdout", source);
    source[0] = 0;
    await expect(copyLog.read()).resolves.toMatchObject({
      chunks: [{ seq: 1, chunk: "YWI=" }],
    });

    const byteBounded = new CodexExecOutputLog({ maxBytes: 4, maxChunks: 10, maxChunkBytes: 4 });
    byteBounded.append("stdout", Uint8Array.of(97, 97));
    byteBounded.append("stdout", Uint8Array.of(98, 98));
    byteBounded.append("stdout", Uint8Array.of(99, 99));
    await expect(byteBounded.read()).resolves.toMatchObject({
      chunks: [
        { seq: 2, chunk: "YmI=" },
        { seq: 3, chunk: "Y2M=" },
      ],
      nextSeq: 4,
    });

    const chunkBounded = new CodexExecOutputLog({ maxBytes: 10, maxChunks: 2, maxChunkBytes: 4 });
    chunkBounded.append("stdout", Uint8Array.of(1));
    chunkBounded.append("stdout", Uint8Array.of(2));
    chunkBounded.append("stdout", Uint8Array.of(3));
    await expect(chunkBounded.read()).resolves.toMatchObject({
      chunks: [
        { seq: 2, chunk: "Ag==" },
        { seq: 3, chunk: "Aw==" },
      ],
      nextSeq: 4,
    });
  });

  it("rejects an oversized append before allocating a sequence", () => {
    const log = new CodexExecOutputLog({ maxChunkBytes: 2 });
    expect(() => log.append("stdout", Uint8Array.of(1, 2, 3))).toThrow(RangeError);
    expect(log.append("stdout", Uint8Array.of(1))).toMatchObject({ seq: 1 });
  });

  it("does not lose output arriving while a long poll is being armed", async () => {
    vi.useFakeTimers();
    try {
      const log = new CodexExecOutputLog();
      const pending = log.read({ waitMs: 1_000 });
      const output = log.append("stdout", Uint8Array.of(42));
      await expect(pending).resolves.toMatchObject({
        chunks: [output],
        nextSeq: 2,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an empty snapshot when the requested long poll times out", async () => {
    vi.useFakeTimers();
    try {
      const log = new CodexExecOutputLog();
      const pending = log.read({ waitMs: 25 });
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toMatchObject({ chunks: [], nextSeq: 1, exited: false });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending reads on abort and dispose", async () => {
    vi.useFakeTimers();
    try {
      const log = new CodexExecOutputLog();
      const controller = new AbortController();
      const abortedRead = log.read({ waitMs: 60_000 }, controller.signal);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      await expect(abortedRead).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);

      const disposedRead = log.read({ waitMs: 60_000 });
      expect(vi.getTimerCount()).toBe(1);
      log.dispose();
      await expect(disposedRead).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
      await expect(log.read()).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });
});
