import type { MemoryRegions } from "../wasi/MemoryRegions.ts";

export type NimbusMemoryPlan = (
  regions: MemoryRegions,
  args: readonly number[],
  memorySize: number,
) => void;

function output(regions: MemoryRegions, pointer: number, capacity: number, memorySize: number) {
  // Nimbus validates the actual record size, which can fit even when capacity exceeds memory.
  const remaining = Math.max(0, memorySize - (pointer >>> 0));
  regions.add(pointer, Math.min(capacity >>> 0, remaining));
}

export const nimbusPlans: Readonly<Record<string, NimbusMemoryPlan>> = {
  startup_cwd: (regions, args, memorySize) => output(regions, args[0]!, args[1]!, memorySize),
  stat_metadata(regions, args) {
    if (args[1] !== 0) regions.add(args[1]!, args[2]!);
    regions.add(args[4]!, 12);
  },
  account(regions, args, memorySize) {
    if (args[1] === 1) regions.add(args[2]!, args[3]!);
    output(regions, args[5]!, args[6]!, memorySize);
    regions.add(args[7]!, 4);
  },
  chmod: (regions, args) => regions.add(args[0]!, args[1]!),
  fchmod: () => {},
  chown(regions, args) {
    if (args[1] !== 0) regions.add(args[1]!, args[2]!);
  },
};
