import type { RecoveryEvidence, RecoveryInspection } from "./RecoveryEvidence.ts";
import type {
  RecoveryDrillCommand,
  RecoveryDrillExpected,
  RecoveryDrillFault,
  RecoveryDrillHost,
  RecoveryDrillState,
} from "./RecoveryDrill.ts";

const rejection = (error: string) => ({ error });
const isHeavy = (evidence: RecoveryEvidence) => evidence.lease.machineClass !== "light";
const targetOf = (evidence: RecoveryEvidence) => ({
  generation: evidence.lease.generation,
  runId: evidence.activeRunId,
  machineId: evidence.machine.machineId,
});
const providerStatus = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null || !("status" in cause)) return undefined;
  const status = cause.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 599
    ? status
    : undefined;
};
const failedDeleteOutcome = (status: number | undefined) =>
  status === 404
    ? "absent"
    : status !== undefined && status >= 400 && status < 500
      ? "rejected"
      : "unknown";
const updateFault = (
  state: RecoveryDrillState,
  faultId: string,
  update: (fault: RecoveryDrillFault) => RecoveryDrillFault,
): RecoveryDrillState => ({
  ...state,
  faults: state.faults.map((fault) => (fault.id === faultId ? update(fault) : fault)),
});
const evidenceOrError = (
  evidence: RecoveryInspection,
):
  | { readonly ok: true; readonly evidence: RecoveryEvidence }
  | { readonly ok: false; readonly error: string } =>
  evidence === null
    ? { ok: false, error: "not_found" }
    : "error" in evidence
      ? { ok: false, error: evidence.error }
      : { ok: true, evidence };

export const makeRecoveryDrillMachineKiller = (options: {
  readonly host: RecoveryDrillHost;
  readonly enabled: () => boolean;
  readonly incarnation: () => Promise<string>;
  readonly matches: (expected: RecoveryDrillExpected, evidence: RecoveryEvidence) => boolean;
}) => {
  const kill = async (userId: string, command: RecoveryDrillCommand) => {
    if (!options.enabled()) return rejection("disabled");
    if (command.machineId !== undefined) return rejection("invalid_command");
    const control = await options.host.boatControl();

    const prepared = await options.host.exclusive(async (read) => {
      const found = evidenceOrError(await read(userId, command.commandIds));
      if (!found.ok) {
        return { tag: "return" as const, value: rejection(found.error) };
      }
      const evidence = found.evidence;
      const state = await options.host.load();
      if (state === undefined || state.userId !== userId) {
        return { tag: "return" as const, value: rejection("not_enrolled") };
      }
      if (!state.enabled) return { tag: "return" as const, value: rejection("not_enrolled") };

      const previous = state.faults.find((fault) => fault.id === command.id);
      if (previous !== undefined) {
        if (previous.action !== command.action) {
          return { tag: "return" as const, value: rejection("id_conflict") };
        }
        if (previous.machineOutcome === "reserved" && !previous.complete) {
          const machineId = previous.before.machine.machineId;
          if (machineId === null) {
            return { tag: "return" as const, value: rejection("not_boat_machine") };
          }
          if (control === null) {
            return {
              tag: "return" as const,
              value: { incarnation: await options.incarnation(), evidence, state, replayed: true },
            };
          }
          return {
            tag: "execute" as const,
            machineId,
            before: previous.before,
            control,
            replayed: true,
          };
        }
        return {
          tag: "return" as const,
          value: { incarnation: await options.incarnation(), evidence, state, replayed: true },
        };
      }

      if (command.expected === undefined || !options.matches(command.expected, evidence)) {
        return { tag: "return" as const, value: rejection("stale_target") };
      }
      if (evidence.activeRunId === null) {
        return { tag: "return" as const, value: rejection("no_active_run") };
      }
      if (!isHeavy(evidence) || evidence.machine.machineId === null) {
        return { tag: "return" as const, value: rejection("not_boat_machine") };
      }
      if (evidence.machine.desired !== "running") {
        return { tag: "return" as const, value: rejection("stale_target") };
      }
      if (control === null) {
        return { tag: "return" as const, value: rejection("machine_provider_unavailable") };
      }
      if (state.faults.length >= 20) {
        return { tag: "return" as const, value: rejection("fault_limit") };
      }
      if (state.faults.some((fault) => !fault.complete)) {
        return { tag: "return" as const, value: rejection("fault_pending") };
      }

      const fault: RecoveryDrillFault = {
        id: command.id,
        action: "kill-machine",
        incarnation: await options.incarnation(),
        before: evidence,
        deliveries: [],
        complete: false,
        machineOutcome: "reserved",
      };
      const next = { ...state, faults: [...state.faults, fault] };
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 1_500_000) {
        return { tag: "return" as const, value: rejection("evidence_limit") };
      }
      await options.host.save(next);
      return {
        tag: "execute" as const,
        machineId: evidence.machine.machineId,
        before: evidence,
        control,
        replayed: false,
      };
    });
    if (prepared.tag === "return") return prepared.value;

    // Revalidate after releasing the first gate. Persist `unknown` before the request: after
    // this point a lost response must never cause a replay to issue a second DELETE.
    const attempt = await options.host.exclusive(async (read) => {
      const state = await options.host.load();
      const fault = state?.faults.find((item) => item.id === command.id);
      if (state === undefined || state.userId !== userId || fault === undefined) {
        return { tag: "return" as const, value: rejection("not_enrolled") };
      }
      if (fault.machineOutcome !== "reserved" || fault.complete) {
        if (fault.machineOutcome === "cancelled") {
          return {
            tag: "return" as const,
            value: rejection(fault.cancelled ?? "cancelled"),
          };
        }
        return {
          tag: "return" as const,
          value: { incarnation: await options.incarnation(), state, replayed: true },
        };
      }
      if (!state.enabled) {
        const cancelled = updateFault(state, command.id, (item) => ({
          ...item,
          complete: true,
          cancelled: "disabled",
          machineOutcome: "cancelled",
        }));
        await options.host.save(cancelled);
        return { tag: "return" as const, value: rejection("disabled") };
      }
      const current = evidenceOrError(await read(userId, []));
      if (
        !current.ok ||
        !options.matches(targetOf(prepared.before), current.evidence) ||
        !isHeavy(current.evidence) ||
        current.evidence.machine.desired !== "running"
      ) {
        const cancelled = updateFault(state, command.id, (item) => ({
          ...item,
          complete: true,
          cancelled: "stale_target",
          machineOutcome: "cancelled",
        }));
        await options.host.save(cancelled);
        return { tag: "return" as const, value: rejection("stale_target") };
      }
      const inFlight = updateFault(state, command.id, (item) => ({
        ...item,
        machineOutcome: "unknown",
      }));
      await options.host.save(inFlight);
      return { tag: "send" as const };
    });
    if (attempt.tag === "return") return attempt.value;

    let machineOutcome: "accepted" | "absent" | "rejected" | "unknown" = "accepted";
    let status: number | undefined;
    try {
      await prepared.control.remove(prepared.machineId);
    } catch (cause) {
      status = providerStatus(cause);
      machineOutcome = failedDeleteOutcome(status);
    }
    const state = await options.host.exclusive(async () => {
      const current = await options.host.load();
      if (current === undefined || current.userId !== userId) return undefined;
      const complete = machineOutcome === "absent" || machineOutcome === "rejected";
      const next = updateFault(current, command.id, (fault) => ({
        ...fault,
        machineOutcome,
        complete,
        ...(status === undefined ? {} : { providerStatus: status }),
      }));
      await options.host.save(next);
      return next;
    });
    if (machineOutcome === "accepted") {
      return {
        incarnation: await options.incarnation(),
        evidence: prepared.before,
        state,
        machineOutcome,
        replayed: prepared.replayed,
      };
    }
    return {
      error:
        machineOutcome === "absent"
          ? "machine_absent"
          : machineOutcome === "rejected"
            ? "provider_rejected"
            : "provider_outcome_unknown",
      ...(status === undefined ? {} : { providerStatus: status }),
      evidence: prepared.before,
      state,
      machineOutcome,
      replayed: prepared.replayed,
    };
  };

  return { kill };
};
