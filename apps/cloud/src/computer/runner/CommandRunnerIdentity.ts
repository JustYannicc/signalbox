import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerHello,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import type { MachineOwnershipAttestation } from "../Machine.ts";
import type { MachineRunnerOwner } from "../RunnerMachineRuntime.ts";

export function assertCommandRunnerHello(
  hello: RunnerHello,
  threadId: ThreadId,
  owner: MachineOwnershipAttestation,
) {
  if (
    hello.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
    hello.exec !== true ||
    hello.threadId !== threadId ||
    hello.machineId !== owner.machineId ||
    hello.generation !== owner.generation ||
    hello.lastAckedSequence !== 0 ||
    hello.terminalProcessId !== undefined ||
    hello.steers ||
    hello.pulls ||
    hello.drains ||
    hello.feedback ||
    hello.runtimeResponses ||
    hello.workflowStops ||
    (hello.takenRunIds?.length ?? 0) > 0 ||
    (hello.takenPreparations?.length ?? 0) > 0
  )
    throw new Error("Command Runner hello does not match its registration");
}

export function captureCommandRunnerOwner(input: MachineRunnerOwner): MachineOwnershipAttestation {
  const owner = {
    operationId: input.operationId,
    machineId: input.machine.id,
    generation: input.machine.generation,
  };
  if (
    !owner.operationId ||
    !owner.machineId ||
    !Number.isSafeInteger(owner.generation) ||
    owner.generation < 1
  )
    throw new Error("Invalid command Runner ownership");
  return Object.freeze(owner);
}

export function commandRunnerIdentity(owner: MachineOwnershipAttestation) {
  return JSON.stringify([owner.operationId, owner.machineId, owner.generation]);
}
