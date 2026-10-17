import type { RecoveryEvidence, RecoveryInspection } from "./RecoveryEvidence.ts";
import type { RecoveryDrillCommand, RecoveryDrillHost } from "./RecoveryDrill.ts";

const rejection = (error: string) => ({ error });
const isHeavy = (evidence: RecoveryEvidence) => evidence.lease.machineClass !== "light";
const providerStatus = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null || !("status" in cause)) return undefined;
  const status = cause.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 599
    ? status
    : undefined;
};
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

export const makeRecoveryDrillMachineInspector = (options: {
  readonly host: RecoveryDrillHost;
  readonly enabled: () => boolean;
  readonly incarnation: () => Promise<string>;
}) => {
  const inspect = async (userId: string, command: RecoveryDrillCommand) => {
    if (!options.enabled()) return rejection("disabled");
    if (command.machineId === undefined) return rejection("invalid_machine_id");
    const prepared = await options.host.exclusive(async (read) => {
      const found = evidenceOrError(await read(userId, command.commandIds));
      if (!found.ok) return rejection(found.error);
      const state = await options.host.load();
      if (state === undefined || state.userId !== userId) return rejection("not_enrolled");
      const current =
        isHeavy(found.evidence) && found.evidence.machine.machineId === command.machineId;
      const recorded = state.faults.some(
        (fault) =>
          fault.before.threadId === found.evidence.threadId &&
          isHeavy(fault.before) &&
          fault.before.machine.machineId === command.machineId,
      );
      if (!current && !recorded) return rejection("unrecorded_machine");
      return { evidence: found.evidence };
    });
    if ("error" in prepared) return prepared;

    const control = await options.host.boatControl();
    if (control === null) return rejection("machine_provider_unavailable");
    let machine;
    try {
      machine = await control.inspect(command.machineId);
    } catch (cause) {
      const status = providerStatus(cause);
      const safeStatus =
        status === 0 || (status !== undefined && status >= 300) ? status : undefined;
      return {
        error: "provider_error",
        ...(safeStatus === undefined ? {} : { providerStatus: safeStatus }),
      };
    }

    const current = await options.host.exclusive(async (read) => {
      const found = evidenceOrError(await read(userId, []));
      if (!found.ok) return rejection(found.error);
      const state = await options.host.load();
      if (state === undefined || state.userId !== userId) return rejection("not_enrolled");
      if (!machine.exists) {
        const faults = state.faults.map((fault) =>
          fault.action === "kill-machine" &&
          fault.before.machine.machineId === command.machineId &&
          !fault.complete
            ? { ...fault, complete: true, machineOutcome: "absent" as const }
            : fault,
        );
        if (faults.some((fault, index) => fault !== state.faults[index])) {
          const resolved = { ...state, faults };
          await options.host.save(resolved);
          return { evidence: found.evidence, state: resolved };
        }
      }
      return { evidence: found.evidence, state };
    });
    if ("error" in current) return current;
    return {
      incarnation: await options.incarnation(),
      checkedSequence: prepared.evidence.sequence,
      evidence: current.evidence,
      state: current.state,
      machine,
    };
  };

  return { inspect };
};
