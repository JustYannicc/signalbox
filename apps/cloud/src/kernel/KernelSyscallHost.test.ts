import { expect, it } from "vite-plus/test";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";

it("preserves the exact legacy response shape for a port without transfer continuations", async () => {
  const filesystem = new KernelFileSystem({ mounts: [], stdio: [{}, {}, {}] });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  try {
    expect(await host.call({ name: "fd_close", args: [0], memorySize: 0, regions: [] })).toEqual({
      kind: "return",
      value: 0,
      regions: [],
    });
  } finally {
    host.close();
    filesystem.dispose();
  }
});

it("honors a child prefix below the fixed I/O cap", async () => {
  let accepted = 0;
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [
      {},
      {
        write(source) {
          accepted += source.byteLength;
          return source.byteLength;
        },
      },
      {},
    ],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  const table = new Uint8Array(8);
  new DataView(table.buffer).setUint32(0, 128, true);
  new DataView(table.buffer).setUint32(4, 8192, true);
  try {
    expect(
      await host.call({
        name: "fd_write",
        args: [1, 0, 1, 16],
        memorySize: 16384,
        regions: [
          { pointer: 0, direction: "in", bytes: table },
          { pointer: 16, direction: "out", length: 4, bytes: new Uint8Array() },
          { pointer: 128, direction: "in", bytes: new Uint8Array(4096) },
        ],
        transferOffset: 0,
        transferLength: 4096,
      }),
    ).toMatchObject({ kind: "return", value: 0 });
    expect(accepted).toBe(4096);
  } finally {
    host.close();
    filesystem.dispose();
  }
});
