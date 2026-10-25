import type { ForkCommit } from "../../kernel/FilePersistencePorts.ts";
import type { MachineAbsenceAttestation, MachineOwnershipAttestation } from "../Machine.ts";
import type {
  MachineProcessClosureAttestation,
  MachineWorkspaceOwnershipAttestation,
} from "../MachineWorkspace.ts";

export interface MachineIdentity {
  readonly operationId: string;
  readonly id: string;
  readonly generation: number;
}

export function assertMachineOwnership(
  expected: MachineIdentity,
  actual: MachineOwnershipAttestation,
) {
  if (
    actual.operationId !== expected.operationId ||
    actual.machineId !== expected.id ||
    actual.generation !== expected.generation
  ) {
    throw new Error("Machine runtime or provider ownership attestation does not match the journal");
  }
}

export function assertMachineClosed(
  expected: MachineIdentity,
  actual: MachineProcessClosureAttestation,
) {
  assertMachineOwnership(expected, actual);
  if (actual.closed !== true) throw new Error("Machine runtime did not attest command closure");
}

export function assertMachineWorkspaceOwnership(
  expected: MachineIdentity & { readonly before: ForkCommit },
  actual: MachineWorkspaceOwnershipAttestation,
) {
  assertMachineOwnership(expected, actual);
  if (!sameRevision(expected.before, actual.before))
    throw new Error("Resumed machine workspace does not match the journaled revision");
}

export function assertMachineAbsent(operationId: string, absence: MachineAbsenceAttestation) {
  if (absence.operationId !== operationId || absence.providerAbsent !== true)
    throw new Error("Machine provider absence was not attested for this operation");
}

function sameRevision(left: ForkCommit, right: ForkCommit) {
  return (
    left.repository === right.repository && left.fork === right.fork && left.commit === right.commit
  );
}
