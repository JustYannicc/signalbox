import { describe, expect, it, vi } from "vite-plus/test";
import { createChildWasi } from "../ChildWasi.ts";
import { ChildHostLease } from "../ChildHostLease.ts";
import { createWorkerSyscalls } from "../WorkerSyscalls.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("worker syscall memory observation", () => {
  it("reports current guest memory size and stops observing after release", async () => {
    const fixture = createTestFilesystem();
    const observations: number[] = [];
    const lease = new ChildHostLease((residentBytes) => observations.push(residentBytes));
    const worker = createWorkerSyscalls(
      {
        filesystem: fixture.filesystem,
        args: ["/bin/rg"],
        env: {},
        signal: new AbortController().signal,
      },
      lease,
    );
    const module = wasmImportReactor(
      "wasi_snapshot_preview1",
      "args_sizes_get",
      ["i32", "i32"],
      ["i32"],
    );
    const guest = createChildWasi({
      module,
      syscalls: worker.host,
      args: ["/bin/rg"],
      env: {},
    });
    const instance = new WebAssembly.Instance(module, guest.imports);
    guest.bind(instance);
    const run = instance.exports.run;
    if (typeof run !== "function") throw new Error("Guest run export is missing");
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("Guest memory export is missing");

    try {
      expect(() => lease.observe(-1)).toThrow(RangeError);
      expect(() => lease.observe(1.5)).toThrow(RangeError);
      expect(observations).toEqual([]);

      await expect(guest.run(run, 0, 4)).resolves.toBe(0);
      expect(observations).toEqual([65_536]);
      expect([
        new DataView(memory.buffer).getUint32(0, true),
        new DataView(memory.buffer).getUint32(4, true),
      ]).toEqual([1, 8]);

      expect(memory.grow(2)).toBe(1);
      await expect(guest.run(run, 0, 4)).resolves.toBe(0);
      expect(observations).toEqual([65_536, 196_608]);

      lease.release();
      await expect(guest.run(run, 0, 4)).rejects.toMatchObject({ code: "EBADF" });
      expect(observations).toEqual([65_536, 196_608]);
    } finally {
      lease.release();
      worker.close();
      fixture.close();
    }
  });
});
