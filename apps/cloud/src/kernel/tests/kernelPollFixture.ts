import { KernelFileSystem } from "../KernelFileSystem.ts";
import { createKernelSyscallHost } from "../KernelSyscallHost.ts";
import type { KernelMemoryRegion, KernelSyscallResponse } from "../KernelSyscallPort.ts";

const pollResultPointer = 64;
const eventCountPointer = 96;

export function createKernelPollFixture(deadlineMs: number) {
  const filesystem = new KernelFileSystem({ mounts: [] });
  const controller = new AbortController();
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: controller.signal,
  });
  const subscription = new Uint8Array(48);
  const clock = new DataView(subscription.buffer);
  clock.setBigUint64(0, 1n, true);
  clock.setUint8(8, 0);
  clock.setUint32(16, 1, true);
  clock.setBigUint64(24, BigInt(deadlineMs) * 1_000_000n, true);
  clock.setUint16(40, 1, true);

  const request = {
    name: "poll_oneoff",
    args: [0, pollResultPointer, 1, eventCountPointer],
    memorySize: 100,
    regions: [
      { pointer: 0, bytes: subscription, direction: "in" },
      {
        pointer: pollResultPointer,
        bytes: new Uint8Array(),
        direction: "out",
        length: 32,
      },
      {
        pointer: eventCountPointer,
        bytes: new Uint8Array(),
        direction: "out",
        length: 4,
      },
    ] satisfies readonly KernelMemoryRegion[],
  } as const;

  return {
    call: host.call,
    request,
    eventCount(response: KernelSyscallResponse): number {
      if (response.kind !== "return") throw new Error("WASI poll did not return normally");
      const region = response.regions.find(({ pointer }) => pointer === eventCountPointer);
      if (region === undefined || region.bytes.byteLength !== 4)
        throw new Error("WASI poll response omitted its event count");
      return new DataView(
        region.bytes.buffer,
        region.bytes.byteOffset,
        region.bytes.byteLength,
      ).getUint32(0, true);
    },
    abort: () => controller.abort(),
    close() {
      host.close();
      filesystem.dispose();
    },
  };
}
