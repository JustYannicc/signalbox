import * as Schema from "effect/Schema";

import type { RecoveryEvidence, RecoveryInspection } from "./RecoveryEvidence.ts";

export interface RecoveryDrillEnv {
  readonly SIGNALBOX_STAGE?: string;
  readonly ENVIRONMENT_ID?: string;
  readonly RECOVERY_DRILLS?: string;
}

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Expected = Schema.Struct({
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  runId: Schema.NullOr(Id),
  machineId: Schema.NullOr(Id),
});
export const RecoveryDrillCommandSchema = Schema.Struct({
  action: Schema.Literals([
    "inspect",
    "inspect-machine",
    "enroll",
    "disable",
    "reset",
    "retry-alarm",
    "kill-machine",
  ]),
  id: Id,
  machineId: Schema.optionalKey(Id),
  expected: Schema.optionalKey(Expected),
  commandIds: Schema.Array(Id).check(Schema.isMaxLength(20)),
});
export type RecoveryDrillCommand = typeof RecoveryDrillCommandSchema.Type;
export type RecoveryDrillExpected = typeof Expected.Type;
export interface RecoveryDrillFault {
  readonly id: string;
  readonly action: "reset" | "retry-alarm" | "kill-machine";
  readonly incarnation: string;
  readonly before: RecoveryEvidence;
  readonly deliveries: ReadonlyArray<{ readonly isRetry: boolean; readonly retryCount: number }>;
  readonly complete: boolean;
  readonly cancelled?: string;
  readonly machineOutcome?:
    | "reserved"
    | "unknown"
    | "accepted"
    | "absent"
    | "rejected"
    | "cancelled";
  readonly providerStatus?: number;
}

export interface RecoveryDrillState {
  readonly enabled: boolean;
  readonly userId: string;
  readonly faults: ReadonlyArray<RecoveryDrillFault>;
}

export interface RecoveryDrillMachineSnapshot {
  readonly machineId: string;
  readonly exists: boolean;
  readonly state: string | null;
  readonly hydrated: boolean | null;
}

export interface RecoveryDrillMachineControl {
  readonly inspect: (machineId: string) => Promise<RecoveryDrillMachineSnapshot>;
  readonly remove: (machineId: string) => Promise<void>;
}

export type RecoveryInspector = (
  userId: string,
  commandIds: ReadonlyArray<string>,
) => Promise<RecoveryInspection>;

export interface RecoveryDrillHost {
  readonly incarnation: () => Promise<string>;
  readonly load: () => Promise<RecoveryDrillState | undefined>;
  readonly save: (state: RecoveryDrillState, arm?: boolean) => Promise<void>;
  readonly exclusive: <A>(work: (inspect: RecoveryInspector) => Promise<A>) => Promise<A>;
  readonly boatControl: () => Promise<RecoveryDrillMachineControl | null>;
  readonly rearm: () => Promise<void>;
  readonly reset: () => void;
}
