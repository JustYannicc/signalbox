import type { HarnessRequestCheckpoint } from "../HarnessRunStore.ts";
import type { HarnessProcessInvocationSettlement } from "../processPlacement/contracts.ts";
import type { NormalizedContinuation } from "./continuation.ts";
import type { ResumedProcess } from "./resumeAttempt.ts";
import type { OwnedProcessRequest } from "./executionState.ts";
import { authorizePublication } from "./authority.ts";
import { persistTerminalEvidence } from "./terminalEvidence.ts";

export async function stopIdleProcess(input: {
  readonly request: NormalizedContinuation;
  readonly resumed: ResumedProcess;
  readonly owned: OwnedProcessRequest;
  readonly checkpoint: HarnessRequestCheckpoint;
  readonly settlement: HarnessProcessInvocationSettlement;
  readonly storage: DurableObjectStorage;
}) {
  const { request, resumed, owned, checkpoint, settlement, storage } = input;
  const key = `harness-process-idle-stop/v1/${encodeURIComponent(request.runId)}/${encodeURIComponent(request.runStore.request.requestId)}`;
  if ((await storage.get(key)) !== undefined)
    throw new Error("The idle-stop attempt requires explicit recovery.");
  await authorizePublication({
    durable: owned.durable,
    runId: request.runId,
    publication: resumed.publication,
    lifecycle: "accepting",
    currentCheckpoint: {
      checkpointId: checkpoint.native.id,
      manifestSha256: checkpoint.filesystem.sha256,
    },
    request: {
      identity: resumed.prepared.identity,
      controllerClaim: request.control,
      operationId: resumed.process.operationId,
      nativeSessionId: resumed.nativeSessionId,
      checkpointId: resumed.checkpoint.native.id,
      manifestRevision: resumed.checkpoint.filesystem.sha256,
      priorFacetNonce: resumed.process.priorFacetNonce,
      expectedFacetGeneration: resumed.process.expectedFacetGeneration,
    },
  });
  await storage.put(key, { request, phase: "reserved" });
  await persistTerminalEvidence({ storage, owned, settlement });
  await owned.handle.cleanup();
  await resumed.prepared.releasePlacementWriter();
  await storage.put(key, { request, phase: "stopped" });
}
