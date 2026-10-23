import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import { KernelPipe } from "./KernelPipe.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

describe("KernelPipe", () => {
  it.each(["abort", "dispose", "writer-close"] as const)(
    "reports an accepted prefix before %s interrupts a blocking write",
    async (interruption) => {
      const wakes = new KernelWakeRegistry();
      const pipe = new KernelPipe(wakes, 4096);
      const controller = new AbortController();
      try {
        const writing = pipe.writeBlocking(new Uint8Array(5000).fill(7), {
          signal: controller.signal,
        });
        expect(pipe.bufferedBytes).toBe(4096);
        if (interruption === "abort") controller.abort();
        else if (interruption === "dispose") wakes.dispose();
        else pipe.closeWriter();
        expect(await writing).toBe(4096);
        const received = new Uint8Array(4096);
        expect(pipe.tryReadInto(received)).toBe(4096);
        expect(received).toEqual(new Uint8Array(4096).fill(7));
        expect(wakes.size).toBe(0);
      } finally {
        wakes.dispose();
      }
    },
  );

  it("preserves endpoint validation for empty blocking writes", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes);
    try {
      expect(await pipe.writeBlocking(new Uint8Array())).toBe(0);
      pipe.closeReader();
      expect(await pipe.writeBlocking(new Uint8Array())).toBe(0);
      pipe.closeWriter();
      await expect(pipe.writeBlocking(new Uint8Array())).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      wakes.dispose();
    }
  });

  it("keeps write short counts while blocking writes finish across pipe refills", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    const source = Uint8Array.from({ length: 5000 }, (_, index) => index % 251);
    const expected = source.slice(0, 4096);
    try {
      expect(await pipe.write(source)).toBe(4096);
      const shortWrite = new Uint8Array(4096);
      pipe.tryReadInto(shortWrite);
      expect(shortWrite).toEqual(expected);

      pipe.tryWrite(new Uint8Array(4096));
      const blockingSource = source.slice();
      const writing = pipe.writeBlocking(blockingSource);
      blockingSource.fill(99);

      const firstRefill = Promise.withResolvers<void>();
      const unsubscribeFirst = pipe.subscribe("read")(() => firstRefill.resolve());
      const firstDrain = new Uint8Array(2048);
      pipe.tryReadInto(firstDrain);
      await firstRefill.promise;
      unsubscribeFirst();

      const secondRefill = Promise.withResolvers<void>();
      const unsubscribeSecond = pipe.subscribe("read")(() => secondRefill.resolve());
      const secondDrain = new Uint8Array(2048);
      pipe.tryReadInto(secondDrain);
      await secondRefill.promise;
      unsubscribeSecond();

      const thirdRefill = Promise.withResolvers<void>();
      const unsubscribeThird = pipe.subscribe("read")(() => thirdRefill.resolve());
      const thirdDrain = new Uint8Array(2048);
      pipe.tryReadInto(thirdDrain);
      await thirdRefill.promise;
      unsubscribeThird();

      expect(await writing).toBe(source.byteLength);
      const tail = new Uint8Array(2952);
      pipe.tryReadInto(tail);
      expect(firstDrain).toEqual(new Uint8Array(2048));
      expect(secondDrain).toEqual(new Uint8Array(2048));
      expect(thirdDrain).toEqual(expected.subarray(0, 2048));
      expect(tail).toEqual(source.subarray(2048));
      expect(wakes.size).toBe(0);
    } finally {
      wakes.dispose();
    }
  });

  it("completes a 1 MiB blocking write through the fixed-size pipe buffer", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes);
    const source = Uint8Array.from({ length: 1_048_576 }, (_, index) => index % 251);
    const received = new Uint8Array(source.byteLength);
    try {
      const writing = pipe.writeBlocking(source);
      let offset = 0;
      while (offset < received.byteLength) {
        offset += await pipe.readInto(received.subarray(offset));
      }
      expect(await writing).toBe(source.byteLength);
      expect(received).toEqual(source);
      expect(wakes.size).toBe(0);
    } finally {
      wakes.dispose();
    }
  });

  it("bounds the payload blocked writers retain together, falling back to short writes", async () => {
    const wakes = new KernelWakeRegistry();
    const held = new KernelPipe(wakes, 4096);
    const other = new KernelPipe(wakes);
    const source = new Uint8Array(1_048_576).fill(3);
    try {
      const holding = held.writeBlocking(new Uint8Array(16 * 1_048_576).fill(9));
      expect(await other.writeBlocking(source)).toBe(65_536);

      held.closeReader();
      await expect(holding).rejects.toMatchObject({ code: "EPIPE", bytesWritten: 4096 });
      other.tryReadInto(new Uint8Array(65_536));
      const writing = other.writeBlocking(source);
      const received = new Uint8Array(source.byteLength);
      let offset = 0;
      while (offset < received.byteLength) {
        offset += await other.readInto(received.subarray(offset));
      }
      expect(await writing).toBe(source.byteLength);
      expect(received).toEqual(source);
    } finally {
      wakes.dispose();
    }
  });

  it("reports the completed prefix when a blocked write loses its reader", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    try {
      pipe.tryWrite(new Uint8Array(4096));
      const writing = pipe.writeBlocking(new Uint8Array(5000).fill(7));

      const refill = Promise.withResolvers<void>();
      const unsubscribe = pipe.subscribe("read")(() => refill.resolve());
      pipe.tryReadInto(new Uint8Array(4));
      await refill.promise;
      unsubscribe();
      pipe.closeReader();

      await expect(writing).rejects.toMatchObject({ code: "EPIPE", bytesWritten: 4 });
      expect(wakes.size).toBe(0);
    } finally {
      wakes.dispose();
    }
  });

  it("owns blocked Buffer writes even when the caller mutates its bytes", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    try {
      pipe.tryWrite(new Uint8Array(4096));
      const source = NodeBuffer.Buffer.alloc(10, 2);
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
