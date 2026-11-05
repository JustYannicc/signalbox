import type { ProcessSlotLease, ProcessSlotPermit, ProcessSlotPressure } from "../ProcessSlots.ts";
import type { KernelProcessAdmissionPort } from "../../kernel/KernelProcessAdmissionPort.ts";

export interface ChildWorkerSlotRequest {
  readonly codeId: string;
  readonly residentBytes: number;
}

export type ChildWorkerRequester =
  import("../../kernel/KernelCommandIngress.ts").KernelCommandRequester;

export interface ChildWorkerSiblingFamily {
  readonly processes: object | string;
  readonly parentPid: number;
}

export type ChildWorkerCapacityRequester =
  | ChildWorkerRequester
  | { readonly owner: KernelProcessAdmissionPort };

export interface ChildWorkerAdmissionTopology {
  readonly nested: boolean;
  readonly family: ChildWorkerSiblingFamily | undefined;
}

export interface ChildWorkerExecution {
  readonly lease: ProcessSlotLease;
  readonly permit: ProcessSlotPermit;
  readonly loaderId: string;
  readonly residentByteLimit: number;
  observe(residentBytes: number): void;
  lose(reason: "memory" | "isolate"): Promise<void>;
  handoff(): Promise<void>;
}

export interface ChildWorkerPermit {
  readonly execution: ChildWorkerExecution;
  release(): Promise<void>;
}

export interface InternalChildWorkerPermit extends ChildWorkerPermit {
  bind(requester: ChildWorkerCapacityRequester): Promise<void>;
}

export interface ChildWorkerReservation {
  readonly [childWorkerReservationBrand]: typeof childWorkerReservationBrand;
  /** The exact preflight object passed to reserve; it may key the runner's captured modules. */
  readonly request: ChildWorkerSlotRequest;
  run<T>(
    signal: AbortSignal,
    work: (execution: ChildWorkerExecution) => Promise<T>,
    requester: ChildWorkerCapacityRequester,
    code?: ChildWorkerSlotRequest,
  ): Promise<T>;
  cancel(): void;
}

/** A queue position that does not consume a process slot until prepared code is supplied. */
export interface ChildWorkerAdmissionTicket {
  reserve(code: ChildWorkerSlotRequest): Promise<ChildWorkerReservation>;
  cancel(): void;
}

export type ChildWorkerPressureListener = (pressure: ProcessSlotPressure) => void;

export const childWorkerReservationBrand: unique symbol = Symbol("ChildWorkerReservation");
