import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeBuffer from "node:buffer";
import { delayedFixture, hydrationFixture, milestone } from "./NodeFsHydrationFixture.ts";

async function collect(stream: AsyncIterable<unknown>) {
  const chunks: NodeBuffer.Buffer[] = [];
  for await (const chunk of stream) chunks.push(NodeBuffer.Buffer.from(chunk as Uint8Array));
  return NodeBuffer.Buffer.concat(chunks).toString();
}

function waiterMilestone(fixture: ReturnType<typeof delayedFixture>, count: number) {
  const joined = milestone();
  const register = fixture.wakes.register.bind(fixture.wakes);
  vi.spyOn(fixture.wakes, "register").mockImplementation((subscribe) => {
    const result = register(subscribe);
    if (fixture.wakes.size === count) joined.resolve();
    return result;
  });
  return joined.promise;
}

export function testHydratedStreams() {
  describe("NodeFS hydrated streams", () => {
    it("hydrates lazily, respects backpressure and inclusive ranges, and closes once at EOF", async () => {
      const fixture = hydrationFixture();
      try {
        fixture.mark("/lazy", "abcdef");
        const close = vi.spyOn(fixture.kernelFs, "close");
        const stream = fixture.fs.createReadStream("/lazy", { highWaterMark: 2, start: 1, end: 4 });
        expect(fixture.requests).toHaveLength(0);
        await expect(collect(stream)).resolves.toBe("bcde");
        expect(stream.bytesRead).toBe(4);
        expect(stream.fd).toBeNull();
        expect(close).toHaveBeenCalledTimes(1);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.wakes.size).toBe(0);
      } finally {
        await fixture.close();
      }
    });

    it("destroy cancels only its read waiter, closes the owned fd, and never emits late bytes", async () => {
      const fixture = delayedFixture();
      try {
        fixture.mark("/lazy", "shared");
        const close = vi.spyOn(fixture.kernelFs, "close");
        const joined = waiterMilestone(fixture, 2);
        const stream = fixture.fs.createReadStream("/lazy", { highWaterMark: 1 });
        const closed = milestone();
        const data: unknown[] = [];
        stream.on("data", (chunk) => data.push(chunk));
        stream.once("close", closed.resolve);
        const other = fixture.fs.promises.readFile("/lazy", "utf8");
        await joined;
        stream.destroy();
        await closed.promise;
        expect(close).toHaveBeenCalledTimes(1);
        expect(fixture.wakes.size).toBe(1);
        expect(fixture.requests[0]?.signal.aborted).toBe(false);
        fixture.release.resolve();
        await expect(other).resolves.toBe("shared");
        expect(data).toEqual([]);
        expect(close).toHaveBeenCalledTimes(2);
        expect(fixture.wakes.size).toBe(0);
      } finally {
        await fixture.close();
      }
    });

    it("aborts a borrowed fd stream without closing or advancing that descriptor", async () => {
      const fixture = delayedFixture();
      try {
        fixture.mark("/lazy", "abcdef");
        const handle = await fixture.fs.promises.open("/lazy", "r");
        const controller = new AbortController();
        const stream = handle.createReadStream({ autoClose: false, signal: controller.signal });
        const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
        const closed = milestone();
        stream.once("close", closed.resolve);
        stream.resume();
        await fixture.started.promise;
        controller.abort();
        await expect(failed).resolves.toMatchObject({ code: "ABORT_ERR" });
        await closed.promise;
        expect(handle.closed).toBe(false);
        expect(fixture.kernelFs.descriptors.get(handle.fd).offset).toBe(0n);
        expect(fixture.wakes.size).toBe(0);
        fixture.release.resolve();
        await expect(handle.readFile("utf8")).resolves.toBe("abcdef");
        await handle.close();
      } finally {
        await fixture.close();
      }
    });

    it("waits for an append and preserves write callbacks, backpressure, and fd ownership", async () => {
      const fixture = delayedFixture();
      try {
        fixture.mark("/lazy", "base");
        const handle = await fixture.fs.promises.open("/lazy", "a");
        const stream = handle.createWriteStream({
          highWaterMark: 1,
          autoClose: false,
          flush: true,
        });
        const drained = milestone();
        const finished = milestone();
        const callback = vi.fn();
        stream.once("drain", drained.resolve);
        stream.once("finish", finished.resolve);
        expect(stream.write("!", callback)).toBe(false);
        await fixture.started.promise;
        expect(callback).not.toHaveBeenCalled();
        fixture.release.resolve();
        await drained.promise;
        stream.end("?");
        await finished.promise;
        expect(callback).toHaveBeenCalledTimes(1);
        expect(stream.bytesWritten).toBe(2);
        expect(handle.closed).toBe(false);
        expect(fixture.kernelFs.descriptors.get(handle.fd).offset).toBe(6n);
        expect(fixture.fs.readFileSync("/lazy", "utf8")).toBe("base!?");
        await handle.close();
      } finally {
        await fixture.close();
      }
    });

    it("destroy cancels a pending write and closes once while a shared reader completes", async () => {
      const fixture = delayedFixture();
      try {
        fixture.mark("/lazy", "base");
        const joined = waiterMilestone(fixture, 2);
        const stream = fixture.fs.createWriteStream("/lazy", { flags: "a" });
        const close = vi.spyOn(fixture.kernelFs, "close");
        const closed = milestone();
        const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
        stream.once("close", closed.resolve);
        const callback = vi.fn();
        stream.write("!", callback);
        const other = fixture.fs.promises.readFile("/lazy", "utf8");
        await joined;
        const reason = new Error("stop writing");
        stream.destroy(reason);
        await expect(failed).resolves.toBe(reason);
        await closed.promise;
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0]?.[0]).toBe(reason);
        expect(close).toHaveBeenCalledTimes(1);
        expect(fixture.wakes.size).toBe(1);
        fixture.release.resolve();
        await expect(other).resolves.toBe("base");
        expect(close).toHaveBeenCalledTimes(2);
        expect(fixture.wakes.size).toBe(0);
      } finally {
        await fixture.close();
      }
    });

    it("retains partial write progress when a later write is cancelled", async () => {
      const fixture = delayedFixture();
      try {
        const { fs, kernelFs } = fixture;
        fixture.mark("/gate", "g");
        const gate = fs.openSync("/gate");
        const original = kernelFs.write.bind(kernelFs);
        let writes = 0;
        vi.spyOn(kernelFs, "write").mockImplementation((fd, bytes, position) => {
          if (++writes === 1) return original(fd, bytes.subarray(0, 2), position);
          kernelFs.read(gate, new Uint8Array(1), 0n);
          return original(fd, bytes, position);
        });
        const stream = fs.createWriteStream("/partial");
        const closed = milestone();
        stream.once("close", closed.resolve);
        stream.on("error", () => {});
        stream.write("abcdef");
        await fixture.started.promise;
        expect(stream.bytesWritten).toBe(2);
        stream.destroy();
        await closed.promise;
        expect(fs.readFileSync("/partial", "utf8")).toBe("ab");
        expect(writes).toBe(2);
        expect(fixture.wakes.size).toBe(0);
        fs.closeSync(gate);
      } finally {
        await fixture.close();
      }
    });

    it("destroy interrupts hydration in open without leaking a late owned descriptor", async () => {
      const fixture = delayedFixture();
      try {
        fixture.mark("/lazy", "base");
        const stream = fixture.fs.createWriteStream("/lazy", { flags: "w" });
        const closed = milestone();
        const opened = vi.fn();
        stream.on("open", opened);
        stream.once("close", closed.resolve);
        // Destroying without an error keeps the stream's ordinary close contract.
        stream.on("error", () => {});
        stream.end("replacement");
        await fixture.started.promise;
        stream.destroy();
        await closed.promise;
        expect(stream.fd).toBeNull();
        expect(opened).not.toHaveBeenCalled();
        expect(fixture.wakes.size).toBe(0);
        fixture.release.resolve();
        await expect(fixture.fs.promises.readFile("/lazy", "utf8")).resolves.toBe("base");
      } finally {
        await fixture.close();
      }
    });
  });
}
