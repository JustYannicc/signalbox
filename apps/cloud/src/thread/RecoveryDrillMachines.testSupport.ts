import { RunId, ThreadId } from "@t3tools/contracts";

import {
  makeRecoveryDrill,
  type RecoveryDrillEnv,
  type RecoveryDrillState,
} from "./RecoveryDrill.ts";
import { NO_MACHINE } from "./ThreadStore.ts";
import type { RecoveryEvidence, RecoveryInspection } from "./RecoveryEvidence.ts";

export const preview: RecoveryDrillEnv = {
  SIGNALBOX_STAGE: "pr-123",
  ENVIRONMENT_ID: "cloud-preview-123",
  RECOVERY_DRILLS: "1",
};
const { token: _token, ...emptyLease } = NO_MACHINE;
export const active: RecoveryEvidence = {
  threadId: ThreadId.make("disposable"),
  sequence: 10,
  activeRunId: RunId.make("run-1"),
  lease: { ...emptyLease, generation: 5, status: "connected", machineClass: "heavy" },
  machine: { machineId: "bx_old", createKey: null, desired: "running", settled: false },
  events: [],
  receipts: [],
  sessions: [],
  runs: [],
  reasoning: [],
};
export const expected = {
  generation: active.lease.generation,
  runId: active.activeRunId,
  machineId: active.machine.machineId,
};
export const command = (action: string, id = "fault-1") => ({
  action,
  id,
  commandIds: [],
  expected,
});

export const fixture = (startingEvidence: RecoveryInspection = active) => {
  let state: RecoveryDrillState | undefined;
  let evidence = startingEvidence;
  let removeCalls = 0;
  const removed: Array<string> = [];
  const inspected: Array<string> = [];
  const machines = new Map<
    string,
    { exists: boolean; state: string | null; hydrated: boolean | null }
  >([
    ["bx_old", { exists: true, state: "ready", hydrated: true }],
    ["bx_new", { exists: true, state: "provisioning", hydrated: false }],
  ]);
  let deleteFailure: unknown;
  let inspectFailure: unknown;
  let afterNextExclusive: (() => Promise<void>) | undefined;
  let incarnations = 0;
  let inExclusive = false;
  let providerCallsInsideExclusive = 0;
  const drill = () =>
    makeRecoveryDrill(preview, {
      incarnation: async () => `object-${++incarnations}`,
      load: async () => structuredClone(state),
      save: async (next) => {
        state = structuredClone(next);
      },
      exclusive: async (work) => {
        const result = await (async () => {
          inExclusive = true;
          try {
            return await work(async () => evidence);
          } finally {
            inExclusive = false;
          }
        })();
        const after = afterNextExclusive;
        afterNextExclusive = undefined;
        await after?.();
        return result;
      },
      boatControl: async () => ({
        inspect: async (machineId) => {
          if (inExclusive) providerCallsInsideExclusive += 1;
          inspected.push(machineId);
          if (inspectFailure !== undefined) throw inspectFailure;
          const machine = machines.get(machineId);
          return machine === undefined
            ? { machineId, exists: false, state: null, hydrated: null }
            : { machineId, ...machine };
        },
        remove: async (machineId) => {
          if (inExclusive) providerCallsInsideExclusive += 1;
          removeCalls += 1;
          removed.push(machineId);
          if (deleteFailure !== undefined) throw deleteFailure;
          machines.set(machineId, { exists: false, state: null, hydrated: null });
        },
      }),
      reset: () => {},
      rearm: async () => {},
    });
  return {
    drill,
    get state() {
      return state;
    },
    get evidence() {
      return evidence;
    },
    get removeCalls() {
      return removeCalls;
    },
    removed,
    get providerCallsInsideExclusive() {
      return providerCallsInsideExclusive;
    },
    inspected,
    setEvidence: (next: RecoveryInspection) => {
      evidence = next;
    },
    setDeleteFailure: (error: unknown) => {
      deleteFailure = error;
    },
    setInspectFailure: (error: unknown) => {
      inspectFailure = error;
    },
    setAfterNextExclusive: (work: () => Promise<void>) => {
      afterNextExclusive = work;
    },
  };
};
