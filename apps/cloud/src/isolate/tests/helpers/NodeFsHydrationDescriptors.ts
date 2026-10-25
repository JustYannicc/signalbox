import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeBuffer from "node:buffer";
import { createNodeFs } from "../../NodeFs.ts";
import { delayedFixture, hydrationFixture, milestone } from "./NodeFsHydrationFixture.ts";

type Api = "promises" | "callback" | "handle";
const abortCases = (["promises", "callback", "handle"] as const).flatMap((api) => [
  { api, label: "custom Error", reason: Object.assign(new Error("caller left"), { code: "EIO" }) },
  { api, label: "null", reason: null },
]);

async function abortableFile(
  fixture: ReturnType<typeof hydrationFixture>,
  api: Api,
  signal: AbortSignal,
  write = false,
) {
  const path = write ? "/write" : "/lazy";
  const options = { signal };
  if (api === "handle") {
    const handle = await fixture.fs.promises.open(path, write ? "r+" : "r");
    try {
      return write ? await handle.writeFile("abcdef", options) : await handle.readFile(options);
    } finally {
      await handle.close();
    }
  }
  if (api === "promises")
    return write
      ? fixture.fs.promises.writeFile(path, "abcdef", options)
      : fixture.fs.promises.readFile(path, options);
  return new Promise((resolve, reject) => {
    if (write)
      fixture.fs.writeFile(path, "abcdef", options, (error) =>
        error ? reject(error) : resolve(undefined),
      );
    else
      fixture.fs.readFile(path, options, (error, bytes) =>
        error ? reject(error) : resolve(bytes),
      );
  });
}

function expectAbort(error: unknown, reason: unknown) {
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  if (!(error instanceof Error)) throw new Error("Expected an abort error");
  expect(error.cause).toBe(reason);
}

export function testHydratedDescriptors() {
  describe("NodeFS user aborts", () => {
    it.each(abortCases)("$api wraps a pre-call $label abort", async ({ api, reason }) => {
      const fixture = hydrationFixture();
      try {
        fixture.mark("/lazy", "bytes");
        const controller = new AbortController();
        controller.abort(reason);
        const error = await abortableFile(fixture, api, controller.signal).catch(
          (error: unknown) => error,
        );
        expectAbort(error, reason);
        expect(fixture.requests).toHaveLength(0);
        expect(fixture.wakes.size).toBe(0);
      } finally {
        await fixture.close();
      }
    });

    it.each(abortCases)("$api wraps a mid-hydration $label abort", async ({ api, reason }) => {
      const fixture = delayedFixture();
      try {
        fixture.mark("/lazy", "bytes");
        const controller = new AbortController();
        const reading = abortableFile(fixture, api, controller.signal).catch(
          (error: unknown) => error,
        );
        await fixture.started.promise;
        controller.abort(reason);
        expectAbort(await reading, reason);
        expect(fixture.requests[0]?.signal.aborted).toBe(false);
        expect(fixture.wakes.size).toBe(0);
      } finally {
        await fixture.close();
      }
    });

    it.each(abortCases)(
      "$api wraps a between-leaf $label abort without replay",
      async ({ api, reason }) => {
        const fixture = hydrationFixture();
        try {
          fixture.fs.writeFileSync("/write", "");
          const controller = new AbortController();
          const original = fixture.kernelFs.write.bind(fixture.kernelFs);
          const writes = vi
            .spyOn(fixture.kernelFs, "write")
            .mockImplementation((fd, bytes, position) => {
              const written = original(fd, bytes.subarray(0, 2), position);
              controller.abort(reason);
              return written;
            });
          const error = await abortableFile(fixture, api, controller.signal, true).catch(
            (error: unknown) => error,
          );
          expectAbort(error, reason);
          expect(writes).toHaveBeenCalledTimes(1);
          expect(fixture.fs.readFileSync("/write", "utf8")).toBe("ab");
          expect(fixture.wakes.size).toBe(0);
        } finally {
          await fixture.close();
        }
      },
    );

    it.each(["EIO", "EAGAIN"])(
      "keeps a raw %s failure even when the user aborts with that same error",
      async (code) => {
        const fixture = hydrationFixture();
        try {
          fixture.fs.writeFileSync("/ready", "bytes");
          const controller = new AbortController();
          const failure = Object.assign(new Error("I/O failed"), { code });
          const reads = vi.spyOn(fixture.kernelFs, "read").mockImplementation(() => {
            controller.abort(failure);
            throw failure;
          });
          let error = await fixture.fs.promises
            .readFile("/ready", { signal: controller.signal })
            .catch((error: unknown) => error);
          expect(error).toMatchObject({ name: "Error", code });
          while (error instanceof Error && error.cause) error = error.cause;
          expect(error).toBe(failure);
          expect(reads).toHaveBeenCalledTimes(1);
          expect(fixture.requests).toHaveLength(0);
          expect(fixture.wakes.size).toBe(0);
        } finally {
          await fixture.close();
        }
      },
    );
  });
  describe("NodeFS hydration descriptor ownership", () => {
    it("drains a pending FileHandle read before concurrent close calls and rejects reuse", async () => {
      const fixture = delayedFixture();
      try {
        fixture.mark("/lazy", "before close");
        const handle = await fixture.fs.promises.open("/lazy");
        const closed = vi.spyOn(fixture.kernelFs, "close");
        const reading = fixture.fs.promises.readFile(handle, "utf8");
        await fixture.started.promise;
        const firstClose = handle.close();
        const secondClose = handle.close();
        expect(closed).not.toHaveBeenCalled();
        await expect(handle.readFile()).rejects.toMatchObject({ code: "EBADF" });
        fixture.release.resolve();
        await expect(reading).resolves.toBe("before close");
        await Promise.all([firstClose, secondClose]);
        expect(closed).toHaveBeenCalledExactlyOnceWith(handle.fd);
        fixture.fs.writeFileSync("/other", "other data");
        const other = fixture.fs.openSync("/other");
        await expect(fixture.fs.promises.readFile(handle)).rejects.toMatchObject({ code: "EBADF" });
        fixture.fs.closeSync(other);
      } finally {
        await fixture.close();
      }
    });

    it("a FileHandle and its waiting stream share one close", async () => {
      const fixture = delayedFixture();
      try {
        fixture.mark("/lazy", "bytes");
        const handle = await fixture.fs.promises.open("/lazy");
        const stream = handle.createReadStream();
        const ended = milestone();
        stream.once("close", ended.resolve);
        stream.resume();
        await fixture.started.promise;
        const close = vi.spyOn(fixture.kernelFs, "close");
        stream.destroy();
        await Promise.all([handle.close(), ended.promise]);
        expect(close).toHaveBeenCalledExactlyOnceWith(handle.fd);
        expect(handle.closed).toBe(true);
        expect(fixture.wakes.size).toBe(0);
      } finally {
        await fixture.close();
      }
    });

    it("callback fd reads and writes wait on the original syscall and retain offset", async () => {
      const fixture = hydrationFixture();
      try {
        fixture.mark("/read", "abc");
        fixture.mark("/write", "base");
        const read = fixture.fs.openSync("/read");
        const bytes = NodeBuffer.Buffer.alloc(2);
        const readCount = await new Promise<number>((resolve, reject) =>
          fixture.fs.read(read, bytes, (error, count, buffer) => {
            if (error) {
              reject(error);
              return;
            }
            expect(buffer).toBe(bytes);
            resolve(count);
          }),
        );
        expect(readCount).toBe(2);
        expect(bytes.toString()).toBe("ab");
        expect(fixture.kernelFs.descriptors.get(read).offset).toBe(2n);
        const write = fixture.fs.openSync("/write", "a");
        const writeCount = await new Promise<number>((resolve, reject) =>
          fixture.fs.write(write, "!", (error, count, data) => {
            if (error) {
              reject(error);
              return;
            }
            expect(data).toBe("!");
            resolve(count);
          }),
        );
        expect(writeCount).toBe(1);
        expect(fixture.fs.readFileSync("/write", "utf8")).toBe("base!");
        fixture.fs.closeSync(read);
        fixture.fs.closeSync(write);
        expect(fixture.requests).toHaveLength(2);
      } finally {
        await fixture.close();
      }
    });

    it("keeps injected stdio and partial writes on the existing kernel descriptors", async () => {
      let inputRead = false;
      let stdout = "";
      const fixture = hydrationFixture({
        stdio: [
          {
            readInto(target) {
              if (inputRead) return 0;
              target[0] = 73;
              inputRead = true;
              return 1;
            },
          },
          {
            write(bytes) {
              stdout += NodeBuffer.Buffer.from(bytes.subarray(0, 1)).toString();
              return 1;
            },
          },
          {},
        ],
      });
      try {
        await expect(fixture.fs.promises.readFile(0, "utf8")).resolves.toBe("I");
        await fixture.fs.promises.writeFile(1, "ABC");
        expect(stdout).toBe("ABC");
        expect(fixture.kernelFs.descriptors.get(0).kind).toBe("stdio");
        expect(fixture.kernelFs.descriptors.get(1).kind).toBe("stdio");
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    });

    it("keeps promises without an injected runner explicit about pending content", async () => {
      const fixture = hydrationFixture();
      try {
        fixture.mark("/lazy", "bytes");
        const { fs } = createNodeFs(fixture.kernelFs);
        await expect(fs.promises.readFile("/lazy")).rejects.toMatchObject({ code: "EAGAIN" });
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    });
  });
}
