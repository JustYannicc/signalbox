import type { HarnessProcessInvocationSettlement } from "../processPlacement/contracts.ts";
import type { OwnedProcessRequest } from "./executionState.ts";
import { readCompletedJournal } from "./completedJournal.ts";
import { sameData } from "./checkpointContract.ts";
import { samePublisher, sameReference } from "./authority.ts";

export async function validateIdleCompletion(
  owned: OwnedProcessRequest,
  settlement: HarnessProcessInvocationSettlement,
) {
  if (
    owned.retained ||
    settlement.processRetained !== true ||
    settlement.stopAcknowledged ||
    !settlement.joined.invocationRpc ||
    settlement.joined.fetch ||
    settlement.joined.ports
  )
    throw new Error("The returned request did not retain its native process resources.");
  const journal = await readCompletedJournal(owned);
  const completion = await owned.completion.promise;
  if (
    owned.retained ||
    completion?.status !== "committed" ||
    !sameData(settlement.value, journal.result) ||
    completion.files.checkpoint.checkpointId !== journal.finish.checkpoint.native.id ||
    completion.files.checkpoint.manifestSha256 !== journal.finish.checkpoint.filesystem.sha256
  )
    throw new Error("The idle request lacks a matching committed checkpoint.");
  const current = await owned.durable.threadSupervisor.execute({
    type: "read",
    runId: owned.runId,
    control: owned.control,
  });
  if (
    current.snapshot.lifecycle !== "accepting" ||
    current.snapshot.admittedStepId !== null ||
    current.snapshot.nativeSessionId !== owned.process.nativeSessionId ||
    !samePublisher(current.currentPublisher, owned.publisher) ||
    !sameReference(current.snapshot.checkpoint, completion.files.checkpoint)
  )
    throw new Error("The completed request no longer has current idle authority.");
  return journal.finish.checkpoint;
}
