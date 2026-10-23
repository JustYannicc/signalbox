import type { ProcessSlots, ProcessSlotsOptions } from "./processSlots/ProcessSlotTypes.ts";
import { ProcessSlotAllocator } from "./processSlots/ProcessSlotAllocator.ts";
import { ProcessSlotJournal } from "./processSlots/ProcessSlotJournal.ts";
import { bytes, ownerNamespace } from "./processSlots/ProcessSlotState.ts";

export type {
  ProcessSlotLeaseToken,
  ProcessSlotLease,
  ProcessSlotRequest,
  ProcessSlotPermit,
  ProcessSlots,
  ProcessSlotSignals,
  ProcessSlotPressure,
  ProcessSlotState,
  ProcessSlotStore,
  ProcessSlotsOptions,
} from "./processSlots/ProcessSlotTypes.ts";
export { ProcessSlotStorageError } from "./processSlots/ProcessSlotJournal.ts";
export {
  codeId as validateProcessSlotCodeId,
  ownerNamespace as validateProcessSlotOwner,
} from "./processSlots/ProcessSlotState.ts";

export async function createProcessSlots(options: ProcessSlotsOptions): Promise<ProcessSlots> {
  ownerNamespace(options.owner);
  for (const value of [
    options.residentByteLimit,
    options.inFlightLimit,
    options.recoveryConcurrency ?? 4,
  ]) {
    bytes(value);
    if (value === 0) throw new RangeError("Process-slot capacities must be positive");
  }
  const journal = await ProcessSlotJournal.open(options.store, options.owner);
  const allocator = new ProcessSlotAllocator(journal, options);
  await allocator.recover();
  return allocator;
}
