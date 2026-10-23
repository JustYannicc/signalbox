import type { ProcessSlots, ProcessSlotsOptions } from "./ProcessSlotTypes.ts";
import { ProcessSlotAllocator } from "./ProcessSlotAllocator.ts";
import { ProcessSlotJournal } from "./ProcessSlotJournal.ts";
import { bytes, ownerNamespace } from "./ProcessSlotState.ts";

export type {
  ProcessSlotLeaseToken,
  ProcessSlotLease,
  ProcessSlotRequest,
  ProcessSlotPermit,
  ProcessSlots,
  ProcessSlotSignals,
  ProcessSlotState,
  ProcessSlotStore,
  ProcessSlotsOptions,
} from "./ProcessSlotTypes.ts";
export { ProcessSlotStorageError } from "./ProcessSlotJournal.ts";

export async function createProcessSlots(options: ProcessSlotsOptions): Promise<ProcessSlots> {
  ownerNamespace(options.owner);
  bytes(options.residentByteLimit);
  if (options.residentByteLimit === 0) throw new RangeError("Resident byte limit must be positive");
  if (options.ioContext !== "durable-object" && options.ioContext !== "worker-request") {
    throw new TypeError("Unknown process-slot I/O context");
  }
  const journal = await ProcessSlotJournal.open(options.store, options.owner);
  const allocator = new ProcessSlotAllocator(journal, options);
  await allocator.recover();
  return allocator;
}
