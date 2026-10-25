import { describe, expect, it } from "vite-plus/test";
import {
  KERNEL_GIT_MAX_BUFFER_BYTES,
  KERNEL_GIT_MAX_PATH_BYTES,
  planKernelGitMemory,
} from "./KernelGitMemoryPlan.ts";

function plan(
  namespace: "nimbus_fs" | "nimbus_proc",
  name: string,
  args: readonly number[],
  memorySize = 512,
): [number, number][] {
  const ranges: [number, number][] = [];
  planKernelGitMemory(namespace, name, args, memorySize, (pointer, length) => {
    ranges.push([pointer, length]);
  });
  return ranges;
}

describe("Git sparse memory plan", () => {
  it("keeps the path bound and fixed stat output range", () => {
    expect(plan("nimbus_fs", "path_stat", [-100, 1, 64, KERNEL_GIT_MAX_PATH_BYTES, 256])).toEqual([
      [64, KERNEL_GIT_MAX_PATH_BYTES],
      [256, 80],
    ]);
    expect(
      plan("nimbus_fs", "path_stat", [-100, 1, 64, KERNEL_GIT_MAX_PATH_BYTES + 1, 256]),
    ).toEqual([[256, 80]]);
  });

  it("keeps startup cwd bounded inside the 4 GiB guest address space", () => {
    expect(plan("nimbus_proc", "startup_cwd", [-32, 128], 0x1_0000_0000)).toEqual([
      [0xffff_ffe0, 32],
    ]);
    expect(plan("nimbus_proc", "startup_cwd", [512, 16], 512)).toEqual([]);
  });

  it("caps spawn buffers while retaining the PID output", () => {
    expect(
      plan("nimbus_proc", "spawn", [
        16,
        KERNEL_GIT_MAX_BUFFER_BYTES,
        32,
        KERNEL_GIT_MAX_BUFFER_BYTES + 1,
        64,
        7,
        -1,
        -1,
        -1,
        256,
      ]),
    ).toEqual([
      [16, KERNEL_GIT_MAX_BUFFER_BYTES],
      [64, 7],
      [256, 4],
    ]);
  });

  it("preserves missing-argument errors after narrowing numeric arguments", () => {
    expect(() => plan("nimbus_proc", "ids", [])).toThrow(
      new TypeError("Git Nimbus imports use only 32-bit arguments"),
    );
  });
});
