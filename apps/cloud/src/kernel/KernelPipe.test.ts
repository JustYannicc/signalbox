import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import { KernelPipe } from "./KernelPipe.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

describe("KernelPipe", () => {
  it("owns blocked Buffer writes even when the caller mutates its bytes", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    try {
      pipe.tryWrite(new Uint8Array(4096));
      const source = Buffer.alloc(10, 2);
      const writing = pipe.write(source);
      source.fill(9);
      pipe.tryReadInto(new Uint8Array(4096));
      expect(await writing).toBe(10);
      const received = new Uint8Array(10);
      pipe.tryReadInto(received);
      expect([...received]).toEqual(Array.from({ length: 10 }, () => 2));
    } finally {
      wakes.dispose();
    }
  });

  it("preserves large short writes after guest memory growth detaches the source", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 8192);
    try {
      pipe.tryWrite(new Uint8Array(8192));
      const memory = new WebAssembly.Memory({ initial: 1 });
      const source = new Uint8Array(memory.buffer, 0, 5000).fill(7);
      const writing = pipe.write(source);
      memory.grow(1);
      pipe.tryReadInto(new Uint8Array(1));
      expect(await writing).toBe(1);
      const received = new Uint8Array(8192);
      pipe.tryReadInto(received);
      expect(received[8191]).toBe(7);
      expect(wakes.size).toBe(0);
    } finally {
      wakes.dispose();
    }
  });

  it("wakes a blocked reader and preserves ring-buffer order", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    try {
      const first = new Uint8Array(3000);
      const waiting = pipe.readInto(first);
      const source = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
      expect(pipe.tryWrite(source)).toBe(4096);
      expect(await waiting).toBe(3000);
      expect(first).toEqual(source.subarray(0, 3000));
      expect(pipe.tryWrite(source.subarray(0, 3000))).toBe(3000);
      const rest = new Uint8Array(4096);
      expect(pipe.tryReadInto(rest)).toBe(4096);
      expect(rest).toEqual(new Uint8Array([...source.subarray(3000), ...source.subarray(0, 3000)]));
      expect(wakes.size).toBe(0);
    } finally {
      wakes.dispose();
    }
  });

  it("waits for enough space for an atomic write and snapshots blocked bytes", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    try {
      pipe.tryWrite(new Uint8Array(4090).fill(1));
      const source = new Uint8Array(10).fill(2);
      const writing = pipe.write(source);
      source.fill(9);
      expect(pipe.bufferedBytes).toBe(4090);
      pipe.tryReadInto(new Uint8Array(5));
      expect(await writing).toBe(10);
      const bytes = new Uint8Array(4095);
      pipe.tryReadInto(bytes);
      expect([...bytes.subarray(-10)]).toEqual(Array.from({ length: 10 }, () => 2));
      expect(wakes.size).toBe(0);
    } finally {
      wakes.dispose();
    }
  });

  it("drains bytes before EOF and wakes pending writes with EPIPE", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    try {
      pipe.tryWrite(new Uint8Array([1, 2, 3]));
      pipe.closeWriter();
      const target = new Uint8Array(4);
      expect(await pipe.readInto(target)).toBe(3);
      expect(await pipe.readInto(target)).toBe(0);
      const full = new KernelPipe(wakes, 4096);
      full.tryWrite(new Uint8Array(4096));
      const writing = full.write(new Uint8Array([1]));
      full.closeReader();
      await expect(writing).rejects.toMatchObject({ code: "EPIPE" });
      expect(wakes.size).toBe(0);
    } finally {
      wakes.dispose();
    }
  });

  it("reports nonblocking EAGAIN and cancels waits without consuming later data", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    const abort = new AbortController();
    try {
      await expect(pipe.readInto(new Uint8Array(1), { nonblocking: true })).rejects.toMatchObject({
        code: "EAGAIN",
      });
      const waiting = pipe.readInto(new Uint8Array(1), { signal: abort.signal });
      abort.abort();
      await expect(waiting).rejects.toMatchObject({ code: "ECANCELED" });
      pipe.tryWrite(new Uint8Array([7]));
      const value = new Uint8Array(1);
      expect(pipe.tryReadInto(value)).toBe(1);
      expect(value[0]).toBe(7);
      expect(wakes.size).toBe(0);
    } finally {
      wakes.dispose();
    }
  });

  it("reports endpoint closure as readiness and cleans waits on request disposal", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    expect(pipe.ready("read")).toBe(false);
    expect(pipe.ready("write")).toBe(true);
    const waiting = pipe.readInto(new Uint8Array(1));
    wakes.dispose();
    await expect(waiting).rejects.toMatchObject({ code: "ECANCELED" });
    pipe.closeWriter();
    expect(pipe.ready("read")).toBe(true);
    expect(pipe.tryReadInto(new Uint8Array(1))).toBe(0);
  });
});
