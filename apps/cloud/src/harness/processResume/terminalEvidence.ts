import type { HarnessProcessInvocationSettlement } from "../processPlacement/contracts.ts";
import type { HarnessThreadSupervisorControlClaim } from "../HarnessThreadSupervisor.ts";
import type { OwnedProcessRequest } from "./executionState.ts";
import { readCompletedJournal } from "./completedJournal.ts";
import { samePublisher, sameReference } from "./authority.ts";
import { sameData } from "./checkpointContract.ts";
import { markOwnedRequestTerminal } from "../processOwnership/ownedRequest.ts";

export { terminalKey } from "./terminalContract.ts";
export type {
  HarnessProcessResumePreDrainSnapshot,
  ProcessTerminalEvidence,
} from "./terminalContract.ts";
import { terminalKey, type ProcessTerminalEvidence } from "./terminalContract.ts";

/** This runs while B still owns the handle. A released handle can never create this evidence. */
export async function persistTerminalEvidence(input: {
  readonly storage: DurableObjectStorage;
  readonly owned: OwnedProcessRequest;
  readonly settlement?: HarnessProcessInvocationSettlement;
  readonly failure?: unknown;
}): Promise<ProcessTerminalEvidence> {
  const { owned } = input;
  if (owned.retained || input.failure !== undefined || input.settlement === undefined)
    throw new Error("Process invocation is unknown; B ownership must be retained.");
  // Failed or unfinished journal requests cannot produce a completion handoff to wait for.
  await readCompletedJournal(owned);
  const completion = await owned.completion.promise;
  if (completion?.status !== "committed" || owned.retained)
    throw new Error("Process completion is unknown; B ownership must be retained.");
  const stopped = await owned.handle.stop();
  const joined = await owned.handle.join();
  if (!stopped.acknowledged || !joined.invocationRpc || !joined.fetch || !joined.ports)
    throw new Error(
      "The process stop, invocation, fetch pumps, or callback ports have not joined.",
    );
  const journal = await readCompletedJournal(owned);
  if (
    !sameData(input.settlement.value, journal.result) ||
    completion.files.checkpoint.checkpointId !== journal.finish.checkpoint.native.id ||
    completion.files.checkpoint.manifestSha256 !== journal.finish.checkpoint.filesystem.sha256
  )
    throw new Error("The returned invocation and completed checkpoint receipts do not match.");
  const current = await owned.durable.threadSupervisor.execute({
    type: "read",
    runId: owned.runId,
    control: owned.control,
  });
  if (
    current.snapshot.nativeSessionId !== owned.process.nativeSessionId ||
    current.snapshot.admittedStepId !== null ||
    !samePublisher(current.currentPublisher, owned.publisher) ||
    !sameReference(current.snapshot.checkpoint, completion.files.checkpoint) ||
    (current.snapshot.lifecycle !== "accepting" && current.snapshot.lifecycle !== "draining")
  )
    throw new Error("A changed before process termination evidence became durable.");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${owned.process.operationId}\u0000${owned.request.requestId}\u0000${owned.handle.identity.incarnationNonce}`,
    ),
  );
  const evidence: ProcessTerminalEvidence = {
    version: 1,
    runId: owned.runId,
    processId: owned.process.processId,
    processOperationId: owned.process.operationId,
    request: owned.request,
    nativeSessionId: owned.process.nativeSessionId,
    control: owned.control,
    publisher: owned.publisher,
    placement: owned.placement,
    identity: owned.handle.identity,
    finish: journal.finish,
    completion,
    acknowledgementId: Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    stopped: true,
    joined: { invocationRpc: true, fetch: true, ports: true },
  };
  const key = terminalKey(owned.runId, owned.process.operationId, owned.request.requestId);
  await input.storage.transaction(async (transaction) => {
    const previous = await transaction.get<ProcessTerminalEvidence>(key);
    if (previous !== undefined && !sameData(previous, evidence))
      throw new Error("Process stop evidence changed after persistence.");
    await transaction.put(key, evidence);
    await markOwnedRequestTerminal(transaction, owned, key);
  });
  const persisted = await input.storage.get<ProcessTerminalEvidence>(key);
  if (!sameData(persisted, evidence))
    throw new Error("Process stop evidence persistence is unknown.");
  return evidence;
}

/** Replays only observed terminal evidence after beginDrain resets A's stop fields. */
export async function settleTerminalEvidence(input: {
  readonly owned: Pick<OwnedProcessRequest, "runId" | "durable">;
  readonly evidence: ProcessTerminalEvidence;
  readonly control: HarnessThreadSupervisorControlClaim;
}) {
  const { owned, evidence, control } = input;
  const current = await owned.durable.threadSupervisor.execute({
    type: "read",
    runId: owned.runId,
    control,
  });
  if (
    evidence.stopped !== true ||
    !evidence.joined.invocationRpc ||
    !evidence.joined.fetch ||
    !evidence.joined.ports ||
    !samePublisher(current.currentPublisher, evidence.publisher) ||
    current.snapshot.nativeSessionId !== evidence.nativeSessionId ||
    current.snapshot.admittedStepId !== null ||
    !sameReference(current.snapshot.checkpoint, evidence.completion.files.checkpoint)
  )
    throw new Error(
      "The durable stop evidence does not match A's current publisher and checkpoint.",
    );
  await owned.durable.threadSupervisor.execute({
    type: "recordStopAcknowledgement",
    runId: owned.runId,
    control,
    publisher: evidence.publisher,
    expectedGeneration: evidence.publisher.generation,
    requestId: evidence.request.requestId,
    acknowledgementId: evidence.acknowledgementId,
  });
  await owned.durable.threadSupervisor.execute({
    type: "settleInvocation",
    runId: owned.runId,
    control,
    publisher: evidence.publisher,
    expectedGeneration: evidence.publisher.generation,
    outcome: "stopped",
    invocationRpcJoined: evidence.joined.invocationRpc,
    fetchJoined: evidence.joined.fetch,
    callbackPortsJoined: evidence.joined.ports,
  });
  const confirmed = await owned.durable.threadSupervisor.execute({
    type: "read",
    runId: owned.runId,
    control,
  });
  if (
    confirmed.snapshot.lifecycle !== "stopped" ||
    confirmed.snapshot.stopAcknowledgementId !== evidence.acknowledgementId ||
    confirmed.snapshot.settlement?.outcome !== "stopped" ||
    !confirmed.snapshot.settlement.invocationRpcJoined ||
    !confirmed.snapshot.settlement.fetchJoined ||
    !confirmed.snapshot.settlement.callbackPortsJoined ||
    !sameReference(confirmed.snapshot.checkpoint, evidence.completion.files.checkpoint) ||
    !samePublisher(confirmed.currentPublisher, evidence.publisher)
  )
    throw new Error("A did not confirm the durable process stop evidence.");
  return confirmed;
}
