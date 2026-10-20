import { describe, expect, it } from "vite-plus/test";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";

function pollThenStore() {
  const name = (text: string) => [text.length, ...new TextEncoder().encode(text)];
  const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
  const body = [
    0, 0x41, 0, 0x41, 0xc0, 0, 0x41, 1, 0x41, 0xe0, 0, 0x10, 0, 0x1a, 0x41, 0xf0, 0, 0x41, 1, 0x36,
    2, 0, 0x0b,
  ];
  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [2, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
      ...section(2, [1, ...name("wasi_snapshot_preview1"), ...name("poll_oneoff"), 0, 0]),
      ...section(3, [1, 1]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 1]),
      ...section(10, [1, body.length, ...body]),
    ]),
  );
}

describe("WASI execution cancellation", () => {
  it("rejects an already aborted owner before starting the guest", async () => {
    const files = new KernelFileSystem({ mounts: [] });
    const wakes = new KernelWakeRegistry();
    const runtime = createKernelAsyncWasi({ filesystem: files, wakes });
    const instance = new WebAssembly.Instance(pollThenStore(), runtime.wasi.getImportObject());
    const reason = new Error("Ended before launch");
    const descriptors = [...files.descriptors.entries()];
    try {
      await expect(runtime.wasi.start(instance, AbortSignal.abort(reason))).rejects.toBe(reason);
      expect([...files.descriptors.entries()]).toEqual(descriptors);
    } finally {
      await runtime.wasi.close();
      files.dispose();
      wakes.dispose();
    }
  });

  it("unwinds a suspended poll before the guest can write its next instruction", async () => {
    const subscribed = Promise.withResolvers<void>();
    const readiness = Promise.withResolvers<{ bytes: bigint }>();
    let detached = false;
    let pollAborted = false;
    const files = new KernelFileSystem({
      mounts: [],
      stdio: [
        {
          poll(_direction, signal) {
            const abort = () => {
              pollAborted = true;
              readiness.reject(Object.assign(new Error("poll cancelled"), { code: "ECANCELED" }));
            };
            signal?.addEventListener("abort", abort, { once: true });
            subscribed.resolve();
            return readiness.promise.finally(() => {
              signal?.removeEventListener("abort", abort);
              detached = true;
            });
          },
        },
        {},
        {},
      ],
    });
    const wakes = new KernelWakeRegistry();
    const runtime = createKernelAsyncWasi({ filesystem: files, wakes });
    const instance = new WebAssembly.Instance(pollThenStore(), runtime.wasi.getImportObject());
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing memory");
    const view = new DataView(memory.buffer);
    view.setUint8(8, 1);
    view.setUint32(16, 0, true);
    const controller = new AbortController();
    const reason = new Error("Execution owner ended");
    const running = runtime.wasi.start(instance, controller.signal);
    const outcome = running.then(
      () => ({ completed: true as const }),
      (error: unknown) => ({ error }),
    );
    try {
      await subscribed.promise;
      controller.abort(reason);
      expect(await outcome).toEqual({ error: reason });
      expect(pollAborted).toBe(true);
      expect(view.getUint32(112, true)).toBe(0);
      expect(detached).toBe(true);
      await runtime.wasi.close();
      expect(files.descriptors.has(0)).toBe(true);
    } finally {
      readiness.resolve({ bytes: 1n });
      await outcome;
      await runtime.wasi.close();
      files.dispose();
      wakes.dispose();
    }
  });
});
