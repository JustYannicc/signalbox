import { expect, it, vi } from "vite-plus/test";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import { runKernelSuspensionObserver } from "./KernelSuspension.ts";

it.each(["fd_seek", "fd_tell"] as const)(
  "answers a stream %s probe without waiting on a blocked reader's lock",
  async (name) => {
    const filesystem = new KernelFileSystem({ mounts: [], stdio: [{}, {}, {}] });
    const controller = new AbortController();
    const host = createKernelSyscallHost({
      filesystem,
      signal: controller.signal,
      args: [],
      env: {},
    });
    const acquisition = filesystem.descriptors.get(0).acquireIo({}, false);
    const acquired = acquisition.next();
    if (!acquired.done) throw new Error("The idle stream lock unexpectedly suspended");
    const release = acquired.value;
    const entered = Promise.withResolvers<void>();
    const suspended = vi.fn(() => entered.resolve());
    const probe = runKernelSuspensionObserver(suspended, () =>
      host.call({
        name,
        args: name === "fd_seek" ? [0, 0n, 1, 64] : [0, 64],
        memorySize: 128,
        regions: [{ pointer: 64, bytes: new Uint8Array(), direction: "out", length: 8 }],
      }),
    );
    try {
      const first = await Promise.race([
        probe.then((response) => ({ kind: "response" as const, response })),
        entered.promise.then(() => ({ kind: "suspended" as const })),
      ]);
      expect(first).toEqual({
        kind: "response",
        response: { kind: "return", value: 70, regions: [] },
      });
      expect(suspended).not.toHaveBeenCalled();
    } finally {
      release();
      await probe;
      host.close();
      filesystem.dispose();
    }
  },
);
