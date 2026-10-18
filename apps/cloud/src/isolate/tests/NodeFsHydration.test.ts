import { testHydratedDescriptors } from "./helpers/NodeFsHydrationDescriptors.ts";
import { testHydratedStreams } from "./helpers/NodeFsHydrationStreams.ts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeBuffer from "node:buffer";
import { FacetFileHydrationError } from "../../kernel/FacetFilePersistence.ts";
import { createNodeFs } from "../NodeFs.ts";
import { delayedFixture, hydrationFixture } from "./helpers/NodeFsHydrationFixture.ts";

describe("NodeFS async hydration", () => {
  it("keeps sync calls explicit and lazy, then shares one fetch across promises and callbacks", async () => {
    const fixture = delayedFixture();
    try {
      const { fs } = fixture;
      fixture.mark("/lazy", "hydrated bytes");
      expect(fs.statSync("/lazy").size).toBe(14);
      expect(() => fs.readFileSync("/lazy")).toThrow(expect.objectContaining({ code: "EAGAIN" }));
      expect(fixture.requests).toHaveLength(0);
      let callbackCalls = 0;
      const callbackRead = new Promise((resolve, reject) =>
        fs.readFile("/lazy", "utf8", (error, bytes) => {
          callbackCalls++;
          if (error) reject(error);
          else resolve(bytes);
        }),
      );
      const promiseRead = fs.promises.readFile("/lazy", "utf8");
      await fixture.started.promise;
      expect(fixture.requests).toHaveLength(1);
      expect(callbackCalls).toBe(0);
      fixture.release.resolve();
      await expect(callbackRead).resolves.toBe("hydrated bytes");
      await expect(promiseRead).resolves.toBe("hydrated bytes");
      expect(callbackCalls).toBe(1);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.wakes.size).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("cancels one readFile token and closes its fd while another waiter finishes", async () => {
    const fixture = delayedFixture();
    try {
      fixture.mark("/lazy", "shared");
      const controller = new AbortController();
      const closed = vi.spyOn(fixture.kernelFs, "close");
      const cancelled = fixture.fs.promises.readFile("/lazy", { signal: controller.signal });
      const remaining = fixture.fs.promises.readFile("/lazy", "utf8");
      await fixture.started.promise;
      const reason = new Error("caller cancelled");
      controller.abort(reason);
      const error = await cancelled.catch((error: unknown) => error);
      expect(error).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected an abort error");
      expect(error.cause).toBe(reason);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(fixture.requests[0]?.signal.aborted).toBe(false);
      expect(fixture.wakes.size).toBe(1);
      fixture.release.resolve();
      await expect(remaining).resolves.toBe("shared");
      expect(closed).toHaveBeenCalledTimes(2);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.wakes.size).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("preserves the public port failure and caches it until explicit retry", async () => {
    const failure = { code: "NOT_FOUND" as const, message: "source missing" };
    let calls = 0;
    const fixture = hydrationFixture({
      async fetch(input, memory) {
        return ++calls === 1 ? { status: "error", error: failure } : memory.hydration.fetch(input);
      },
    });
    try {
      const inode = fixture.mark("/lazy", "recovered");
      const error = await fixture.fs.promises.readFile("/lazy").catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "NOT_FOUND" });
      expect(error).toBeInstanceOf(Error);
      let cause = error;
      while (cause instanceof Error && cause.cause) cause = cause.cause;
      expect(cause).toBeInstanceOf(FacetFileHydrationError);
      expect(cause).toMatchObject({ persistenceError: failure });
      await expect(fixture.fs.promises.readFile("/lazy")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(calls).toBe(1);
      fixture.persistence.retryHydration(inode);
      await expect(fixture.fs.promises.readFile("/lazy", "utf8")).resolves.toBe("recovered");
      expect(calls).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it("passes the original ordinary EAGAIN to the runner and never waits", async () => {
    const fixture = hydrationFixture();
    try {
      fixture.fs.writeFileSync("/plain", "x");
      const error = Object.assign(new Error("ordinary readiness"), { code: "EAGAIN" });
      vi.spyOn(fixture.kernelFs, "read").mockImplementation(() => {
        throw error;
      });
      const seen: unknown[] = [];
      const { fs } = createNodeFs(fixture.kernelFs, undefined, (operation, signal) =>
        fixture.persistence.runLeaf(() => {
          try {
            return operation();
          } catch (cause) {
            seen.push(cause);
            throw cause;
          }
        }, signal),
      );
      await expect(fs.promises.readFile("/plain")).rejects.toMatchObject({ code: "EAGAIN" });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(error);
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.wakes.size).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("resumes a partial write without replaying open, truncate, bytes, or close", async () => {
    const fixture = delayedFixture();
    try {
      const { fs, kernelFs } = fixture;
      fixture.mark("/gate", "g");
      const gate = fs.openSync("/gate", "r");
      fs.writeFileSync("/target", "old contents");
      const open = vi.spyOn(kernelFs, "open");
      const truncate = vi.spyOn(fixture.persistence.storage, "truncate");
      const close = vi.spyOn(kernelFs, "close");
      const original = kernelFs.write.bind(kernelFs);
      let writes = 0;
      vi.spyOn(kernelFs, "write").mockImplementation((fd, bytes, position) => {
        writes++;
        if (writes === 1) return original(fd, bytes.subarray(0, 2), position);
        kernelFs.read(gate, new Uint8Array(1), 0n);
        return original(fd, bytes, position);
      });
      const writing = fs.promises.writeFile("/target", "abcdef");
      await fixture.started.promise;
      expect(open).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync("/target", "utf8")).toBe("ab");
      expect(truncate).toHaveBeenCalledTimes(1);
      fixture.release.resolve();
      await writing;
      expect(fs.readFileSync("/target", "utf8")).toBe("abcdef");
      expect(open.mock.calls.filter(([path]) => path === "/target")).toHaveLength(3);
      expect(truncate).toHaveBeenCalledTimes(1);
      expect(writes).toBe(3);
      expect(close.mock.calls.filter(([fd]) => fd !== gate)).toHaveLength(3);
      fs.closeSync(gate);
    } finally {
      await fixture.close();
    }
  });

  it("retains earlier read chunks and the shared descriptor offset across a later wait", async () => {
    const fixture = delayedFixture();
    try {
      const { fs, kernelFs } = fixture;
      fixture.mark("/gate", "g");
      fs.writeFileSync("/data", "abcdef");
      const handle = await fs.promises.open("/data", "r");
      const gate = fs.openSync("/gate", "r");
      const original = kernelFs.read.bind(kernelFs);
      let reads = 0;
      vi.spyOn(kernelFs, "read").mockImplementation((fd, bytes, position) => {
        if (fd === gate) return original(fd, bytes, position);
        reads++;
        if (reads > 1) original(gate, new Uint8Array(1), 0n);
        return original(fd, bytes.subarray(0, 2), position);
      });
      const reading = handle.readFile("utf8");
      await fixture.started.promise;
      expect(kernelFs.descriptors.get(handle.fd).offset).toBe(2n);
      fixture.release.resolve();
      await expect(reading).resolves.toBe("abcdef");
      expect(kernelFs.descriptors.get(handle.fd).offset).toBe(6n);
      const close = vi.spyOn(kernelFs, "close");
      await Promise.all([handle.close(), handle.close()]);
      expect(close).toHaveBeenCalledExactlyOnceWith(handle.fd);
      fs.closeSync(gate);
    } finally {
      await fixture.close();
    }
  });

  it("hydrates FileHandle reads, appends, and truncation while retaining fd ownership", async () => {
    const fixture = hydrationFixture();
    try {
      fixture.mark("/read", "abcd");
      fixture.mark("/append", "base");
      fixture.mark("/truncate", "abcdef");
      const read = await fixture.fs.promises.open("/read", "r");
      const bytes = NodeBuffer.Buffer.alloc(2);
      expect(await read.read(bytes)).toMatchObject({ bytesRead: 2, buffer: bytes });
      expect(bytes.toString()).toBe("ab");
      await expect(read.readFile("utf8")).resolves.toBe("cd");
      const append = await fixture.fs.promises.open("/append", "a");
      await append.appendFile("!");
      const truncate = await fixture.fs.promises.open("/truncate", "r+");
      await truncate.truncate(3);
      expect(fixture.fs.readFileSync("/append", "utf8")).toBe("base!");
      expect(fixture.fs.readFileSync("/truncate", "utf8")).toBe("abc");
      await Promise.all([read.close(), append.close(), truncate.close()]);
      expect(fixture.requests).toHaveLength(3);
    } finally {
      await fixture.close();
    }
  });

  it("hydrates copyFile before destination creation and reports callback failures once", async () => {
    const fixture = delayedFixture();
    try {
      fixture.mark("/source", "copy me");
      const copying = fixture.fs.promises.copyFile("/source", "/copy");
      await fixture.started.promise;
      expect(fixture.fs.existsSync("/copy")).toBe(false);
      fixture.release.resolve();
      await copying;
      expect(fixture.fs.readFileSync("/copy", "utf8")).toBe("copy me");
      let calls = 0;
      await new Promise<void>((resolve) =>
        fixture.fs.readFile("/missing", (error) => {
          calls++;
          expect(error?.code).toBe("ENOENT");
          resolve();
        }),
      );
      expect(calls).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});

testHydratedStreams();

testHydratedDescriptors();
