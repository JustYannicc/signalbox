import { describe, expect, it } from "vite-plus/test";
import { KernelCpuAccounting } from "./KernelCpuAccounting.ts";
import { KernelCpuExecution } from "./KernelCpuExecution.ts";
import { AsyncWASI, WASI, type WasiStdio } from "./Wasi.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

function isWasmFunction(value: unknown): value is (...args: Array<number | bigint>) => unknown {
  return typeof value === "function";
}

async function fixture(write: NonNullable<WasiStdio["write"]>, asyncMode = true) {
  const options = {
    version: "preview1",
    stdio: [{}, { write }, {}],
  } satisfies ConstructorParameters<typeof WASI>[0];
  const wasi = asyncMode ? new AsyncWASI(options) : new WASI(options);
  const instance = new WebAssembly.Instance(
    wasmImportReactor("wasi_snapshot_preview1", "fd_write", ["i32", "i32", "i32", "i32"], ["i32"]),
    wasi.getImportObject(),
  );
  await wasi.initialize(instance);
  const { memory, run } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || !isWasmFunction(run)) {
    throw new Error("Missing WASI reactor exports");
  }
  const view = new DataView(memory.buffer);
  view.setUint32(0, 64, true);
  view.setUint32(4, 3, true);
  new Uint8Array(memory.buffer, 64, 3).set([97, 98, 99]);
  return {
    written: () => view.getUint32(32, true),
    call: () => (wasi instanceof AsyncWASI ? wasi.run(run, 1, 0, 1, 32) : run(1, 0, 1, 32)),
    close: () => wasi.close(),
  };
}

describe("WASI call execution through guest imports", () => {
  it("keeps async writes, backend failures and later recovery in order", async () => {
    const events: string[] = [];
    let calls = 0;
    const test = await fixture(async (bytes) => {
      events.push(new TextDecoder().decode(bytes));
      if (++calls === 2) throw Object.assign(new Error("backend failed"), { code: "EIO" });
      return bytes.length;
    });
    try {
      expect(await test.call()).toBe(0);
      expect(test.written()).toBe(3);
      expect(await test.call()).toBe(29);
      expect(await test.call()).toBe(0);
      expect(test.written()).toBe(3);
      expect(events).toEqual(["abc", "abc", "abc"]);
    } finally {
      await test.close();
    }
  });

  it("settles a started write before rejecting a CPU meter failure", async () => {
    const pending = Promise.withResolvers<number>();
    const started = Promise.withResolvers<void>();
    const failure = new Error("meter stopped");
    let fail = false;
    let backendFinished = false;
    let settled = false;
    const execution = new KernelCpuExecution(
      new KernelCpuAccounting(() => {
        if (fail) {
          fail = false;
          throw failure;
        }
        return 1n;
      }),
    );
    const test = await fixture(() => {
      fail = true;
      started.resolve();
      return pending.promise.finally(() => {
        backendFinished = true;
      });
    });
    const running = execution.root.run(async () => {
      const leave = execution.root.enterUser();
      try {
        return await test.call();
      } finally {
        leave();
      }
    });
    const outcome = running.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await started.promise;
      expect(settled).toBe(false);
      pending.resolve(3);
      expect(await outcome).toEqual({ error: failure });
      expect(backendFinished).toBe(true);
      expect(test.written()).toBe(0);
    } finally {
      pending.resolve(3);
      await outcome;
      await test.close();
      execution.root.stop();
    }
  });

  it("rejects asynchronous writes through the synchronous WASI entrypoint", async () => {
    const test = await fixture(() => Promise.resolve(3), false);
    try {
      expect(() => test.call()).toThrow("WASI call requires asynchronous execution");
      expect(test.written()).toBe(0);
    } finally {
      await test.close();
    }
  });
});
