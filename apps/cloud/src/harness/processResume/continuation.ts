import * as Schema from "effect/Schema";
import type { HarnessRequestCheckpoint } from "../HarnessRunStore.ts";
import type { HarnessDurableState } from "../HarnessDurableState.ts";
import type { HarnessProcessExecutionProcessResult } from "../processPlacement/execution.ts";
import { HarnessProcessResumeRunStoreBindingSchema } from "./contracts.ts";
import { HarnessProcessCheckpointInput, sameData } from "./checkpointContract.ts";
import type { ResumedProcess } from "./resumeAttempt.ts";
import type { OwnedProcessRequest } from "./executionState.ts";
import { authorizePublication, sameControl } from "./authority.ts";
import { execute, fail, sameCheckpoint, sameVisibleState } from "./runStoreState.ts";
import { validateIdleCompletion } from "./idleCompletion.ts";
import { persistTerminalEvidence } from "./terminalEvidence.ts";

const binding = HarnessProcessResumeRunStoreBindingSchema.fields;
export const HarnessProcessContinuationInput = Schema.Struct({
  afterTurn: Schema.optionalKey(Schema.Literals(["keep-alive", "dispose"])),
  runId: binding.runId,
  processId: binding.processId,
  executionOperationId: binding.processOperationId,
  resumeOperationId: binding.transitionOperationId,
  control: HarnessProcessCheckpointInput.fields.control,
  runStore: Schema.Struct({
    controlKey: binding.controlKey,
    supervisor: binding.supervisor,
    currentPublisher: binding.currentPublisher,
    request: binding.request,
    checkpoint: binding.checkpoint,
  }),
});
export type HarnessProcessContinuationInput = typeof HarnessProcessContinuationInput.Type;
export type NormalizedContinuation = Omit<
  typeof HarnessProcessContinuationInput.Type,
  "afterTurn"
> & { readonly afterTurn: "keep-alive" | "dispose" };
const decode = Schema.decodeUnknownSync(HarnessProcessContinuationInput, {
  onExcessProperty: "error",
});
export function snapshotContinuation(value: unknown) {
  try {
    const decoded = decode(value);
    return structuredClone({ ...decoded, afterTurn: decoded.afterTurn ?? "dispose" });
  } catch {
    throw new Error(
      "Process continuation requires the exact arrived request and journal capabilities.",
    );
  }
}

export function assertContinuation(
  request: NormalizedContinuation,
  resumed: ResumedProcess,
  checkpoint: HarnessRequestCheckpoint,
) {
  const { operation, prepared, publication, boundary } = resumed;
  if (
    request.runId !== operation.runId ||
    request.processId !== operation.previousProcessId ||
    request.executionOperationId !== boundary.placement.executionOperationId ||
    request.resumeOperationId !== operation.transition.operationId ||
    !sameControl(request.control, operation.transition.nextControl) ||
    request.runStore.controlKey !== operation.runStore.controlKey ||
    request.runStore.currentPublisher.generation !== publication.receipt.toGeneration ||
    request.runStore.currentPublisher.facetNonce !== prepared.identity.incarnationNonce ||
    request.runStore.currentPublisher.publisherKey !== operation.runStore.nextPublisherKey ||
    request.runStore.request.requestId === operation.previousStepId ||
    !sameCheckpoint(request.runStore.checkpoint, checkpoint)
  )
    throw new Error("Continuation does not match the activated process and durable checkpoint.");
}

export async function continueResumedProcess(input: {
  readonly request: NormalizedContinuation;
  readonly resumed: ResumedProcess;
  readonly durable: HarnessDurableState;
  readonly storage: DurableObjectStorage;
  readonly checkpoint: HarnessRequestCheckpoint;
  readonly idle: boolean;
  readonly onIdle: (
    checkpoint: HarnessRequestCheckpoint,
    settlement: import("../processPlacement/contracts.ts").HarnessProcessInvocationSettlement,
  ) => void;
  readonly requestContextId: string;
  readonly onOwned: (owned: OwnedProcessRequest) => void;
  readonly assertOwned: () => void;
}): Promise<HarnessProcessExecutionProcessResult> {
  const { request, resumed, durable } = input;
  const { operation, prepared, publication, boundary } = resumed;
  assertContinuation(request, resumed, input.checkpoint);
  const publicationRequest = {
    identity: prepared.identity,
    controllerClaim: request.control,
    operationId: request.resumeOperationId,
    nativeSessionId: boundary.nativeSessionId,
    checkpointId: boundary.completion.files.checkpoint.checkpointId,
    manifestRevision: boundary.completion.files.checkpoint.manifestSha256,
    priorFacetNonce: operation.transition.publisher.facetNonce,
    expectedFacetGeneration: operation.transition.expectedFacetGeneration,
  };
  const authorize = async () => {
    const observed = await execute(
      durable.runStore,
      { type: "read", runId: request.runId },
      "replacement",
    );
    const requests = observed.snapshot.requests;
    const facet = requests?.facets.at(-1);
    if (
      requests === undefined ||
      facet === undefined ||
      facet.operationId !== request.resumeOperationId ||
      facet.generation !== request.runStore.currentPublisher.generation ||
      facet.facetNonce !== request.runStore.currentPublisher.facetNonce ||
      observed.snapshot.supervisor.epoch !== request.runStore.supervisor.epoch ||
      observed.snapshot.supervisor.claimId !== request.runStore.supervisor.claimId ||
      !sameCheckpoint(requests.checkpoint, request.runStore.checkpoint) ||
      requests.entries.some(
        (entry) => entry.status !== "completed" && entry.status !== "not-applied",
      )
    )
      fail("replacement", "request-changed");
    const checked = await execute(
      durable.runStore,
      {
        type: "request.replaceFacet",
        runId: request.runId,
        controlKey: request.runStore.controlKey,
        expectedGeneration: facet.generation - 1,
        operationId: facet.operationId,
        facetNonce: facet.facetNonce,
        publisherKey: request.runStore.currentPublisher.publisherKey,
      },
      "replacement",
    );
    if (checked.action !== "unchanged" || !sameVisibleState(observed.snapshot, checked.snapshot))
      fail("replacement", "publisher-changed");
    await execute(
      durable.runStore,
      {
        type: "intent",
        runId: request.runId,
        supervisor: request.runStore.supervisor,
        intent: {
          intentId: request.runStore.request.requestId,
          kind: "process-continuation",
          reference: request.runStore.request.input,
        },
      },
      "replacement",
    );
    await authorizePublication({
      durable,
      runId: request.runId,
      publication,
      request: publicationRequest,
      lifecycle: "accepting",
      currentCheckpoint: {
        checkpointId: request.runStore.checkpoint.native.id,
        manifestSha256: request.runStore.checkpoint.filesystem.sha256,
      },
    });
    input.assertOwned();
  };
  const key = `harness-process-continuation/v1/${encodeURIComponent(request.runId)}/${encodeURIComponent(request.runStore.request.requestId)}`;
  const previous = await input.storage.get(key);
  if (previous !== undefined)
    throw new Error("The continuation already has a durable attempt and cannot be replayed.");
  await authorize();
  await input.storage.put(key, { request, phase: "reserved" });
  const controller = new AbortController();
  let owned: OwnedProcessRequest | undefined;
  try {
    if (input.idle) await prepared.handle.readmit(publication);
    else
      await prepared.handle.park(async () => {
        await authorize();
        return { value: undefined, publication };
      }, controller.signal);
    await authorize();
    const offered = await execute(
      durable.runStore,
      {
        type: "request.offer",
        runId: request.runId,
        supervisor: request.runStore.supervisor,
        request: request.runStore.request,
      },
      "replacement",
    );
    if (
      offered.action !== "recorded" ||
      !sameData(offered.snapshot.requests?.entries.at(-1)?.request, request.runStore.request)
    )
      fail("replacement", "request-changed");
    const admitted = await durable.admitStep({
      control: request.control,
      stepId: request.runStore.request.requestId,
      expectedCheckpointId: request.runStore.checkpoint.native.id,
    });
    if (admitted.status !== "admitted")
      throw new Error("Continuation A admission remains pending.");
    await authorizePublication({
      durable,
      runId: request.runId,
      publication,
      request: publicationRequest,
      lifecycle: "accepting",
      currentCheckpoint: {
        checkpointId: request.runStore.checkpoint.native.id,
        manifestSha256: request.runStore.checkpoint.filesystem.sha256,
      },
    });
    input.assertOwned();
    owned = {
      kind: "published",
      runId: request.runId,
      placement: boundary.placement,
      durable,
      handle: prepared.handle,
      publication,
      process: {
        ...operation.facet,
        operationId: request.resumeOperationId,
        nativeSessionId: boundary.nativeSessionId,
        checkpointId: request.runStore.checkpoint.native.id,
        manifestRevision: request.runStore.checkpoint.filesystem.sha256,
        expectedFacetGeneration: operation.transition.expectedFacetGeneration,
        priorFacetNonce: operation.transition.publisher.facetNonce,
      },
      publisher: prepared.preparedPublisher,
      request: request.runStore.request,
      runStorePublisher: request.runStore.currentPublisher,
      journal: {
        ...operation.runStore,
        ...request.runStore,
        processOperationId: request.resumeOperationId,
      },
      parentCheckpoint: request.runStore.checkpoint,
      control: request.control,
      completion: Promise.withResolvers(),
      settled: Promise.withResolvers(),
      retained: false,
    };
    input.onOwned(owned);
    const settlement = await prepared.handle.invoke(
      {
        publisher: request.runStore.currentPublisher,
        requestId: request.runStore.request.requestId,
      },
      request.afterTurn === "keep-alive" ? { retainProcess: true } : undefined,
    );
    if (request.afterTurn === "keep-alive") {
      const checkpoint = await validateIdleCompletion(owned, settlement);
      input.assertOwned();
      await prepared.handle.idle();
      await input.storage.put(key, { request, phase: "idle", checkpoint });
      input.onIdle(checkpoint, settlement);
      return {
        processId: request.processId,
        requestContextId: input.requestContextId,
        identity: prepared.identity,
        status: "idle",
        settlement,
      };
    }
    await persistTerminalEvidence({ storage: input.storage, owned, settlement });
    await prepared.handle.cleanup();
    await prepared.releasePlacementWriter();
    await input.storage.put(key, { request, phase: "completed" });
    return {
      processId: request.processId,
      requestContextId: input.requestContextId,
      identity: prepared.identity,
      status: "settled",
      settlement,
    };
  } catch (cause) {
    if (owned !== undefined) {
      owned.retained = true;
      owned.completion.resolve(undefined);
    }
    try {
      await input.storage.put(key, { request, phase: "retained" });
    } catch {
      /* The original intent and B invocation marker still reserve ownership. */
    }
    throw cause;
  } finally {
    owned?.settled.resolve();
  }
}
