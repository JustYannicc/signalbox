import type { ProcessSlotLease, ProcessSlotState } from "./ProcessSlotTypes.ts";

export type Slot = ProcessSlotState["slots"][number];

export function bytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("Invalid resident byte count");
}

function segment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\s/\\]/u.test(value) &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  );
}

export function codeId(value: string): void {
  if (!segment(value)) throw new TypeError("Code ID must be one nonempty namespace segment");
}

export function ownerNamespace(value: string): void {
  const parts = value.split("/");
  if (parts.length < 2 || !parts.every(segment)) {
    throw new TypeError("Process-slot owner must include supervisor and shard");
  }
}

export function validateState(state: ProcessSlotState, owner: string): void {
  if (state.owner !== owner) throw new TypeError("Process-slot store owner mismatch");
  if (state.version !== 1) throw new TypeError("Unknown process-slot state version");
  bytes(state.lost);
  const keys = new Set<string>();
  const tokens = new Set<string>();
  for (const slot of state.slots) {
    codeId(slot.codeId);
    bytes(slot.index);
    bytes(slot.generation);
    if (slot.invalidating !== undefined) {
      bytes(slot.invalidating);
      if (slot.invalidating >= slot.generation || slot.holder !== undefined) {
        throw new TypeError("Invalid process-slot retirement");
      }
    }
    const key = `${slot.codeId}/${slot.index}`;
    if (keys.has(key)) throw new TypeError("Duplicate process-slot index");
    keys.add(key);
    if (slot.holder === undefined) continue;
    const { token, residentBytes, permitted } = slot.holder;
    bytes(residentBytes);
    if (
      typeof token !== "string" ||
      !token ||
      tokens.has(token) ||
      typeof permitted !== "boolean"
    ) {
      throw new TypeError("Invalid durable process-slot holder");
    }
    tokens.add(token);
  }
}

export function loaderId(owner: string, slot: Slot): string {
  return `${owner}/${slot.codeId}/${slot.index}.${slot.generation}`;
}

export function leaseFor(owner: string, slot: Slot): ProcessSlotLease {
  if (slot.holder === undefined) throw new Error("Process-slot holder is missing");
  return Object.freeze({
    token: slot.holder.token,
    loaderId: loaderId(owner, slot),
    codeId: slot.codeId,
    residentBytes: slot.holder.residentBytes,
  });
}

export function findHolder(state: ProcessSlotState, lease: ProcessSlotLease): Slot | undefined {
  return state.slots.find(
    (slot) =>
      slot.holder?.token === lease.token &&
      slot.codeId === lease.codeId &&
      loaderId(state.owner, slot) === lease.loaderId,
  );
}

export function requireHolder(state: ProcessSlotState, lease: ProcessSlotLease): Slot {
  const slot = findHolder(state, lease);
  if (slot === undefined) throw new Error("Stale process-slot lease");
  return slot;
}

export function replaceSlot(
  state: ProcessSlotState,
  slot: Slot,
  replacement: Slot,
): ProcessSlotState {
  return { ...state, slots: state.slots.map((entry) => (entry === slot ? replacement : entry)) };
}

export function counts(state: ProcessSlotState) {
  let inFlight = 0;
  let resident = 0;
  for (const { holder } of state.slots) {
    if (holder === undefined) continue;
    resident++;
    if (holder.permitted) inFlight++;
  }
  return { inFlight, resident };
}
