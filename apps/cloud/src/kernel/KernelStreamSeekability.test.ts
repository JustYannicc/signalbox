import { expect, it, vi } from "vite-plus/test";
import { runKernelSuspensionObserver } from "./KernelSuspension.ts";
import { WasiFdCalls } from "./wasi/internal_wasi_fd_calls.ts";
import { WasiDescriptorTable } from "./wasi/internal_wasi_descriptors.ts";
import { WasiMemory } from "./wasi/internal_wasi_memory.ts";
import { runAsync } from "./wasi/internal_wasi_calls.ts";

it.each(["seek", "tell"] as const)(
  "answers a stream %s probe without waiting on a blocked reader's lock",
  async (operation) => {
    const descriptors = new WasiDescriptorTable([{}, {}, {}]);
    const memory = new WasiMemory();
    memory.set(new WebAssembly.Memory({ initial: 1 }));
    const calls = new WasiFdCalls(memory, descriptors);
    const release = await runAsync(descriptors.get(0).acquireIo({}, false));
    const suspended = vi.fn();
    const probe = runKernelSuspensionObserver(suspended, () =>
      runAsync(operation === "seek" ? calls.fdSeek(0, 0n, 1, 64) : calls.fdTell(0, 64)),
    );
    const settled = probe.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(suspended).not.toHaveBeenCalled();
      expect(await settled).toEqual({ error: expect.objectContaining({ errno: 70 }) });
    } finally {
      release();
      await settled;
      await runAsync(descriptors.closeAll());
    }
  },
);
