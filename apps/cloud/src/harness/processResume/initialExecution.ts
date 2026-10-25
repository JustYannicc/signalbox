import type { HarnessDurableState } from "../HarnessDurableState.ts";
import type {
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionSupervisorClient,
} from "../processPlacement/execution.ts";
import type { HarnessProcessPublicationRequest } from "../processPlacement/contracts.ts";
import type { HarnessProcessExecutionJournal } from "./contracts.ts";
import { snapshotHarnessProcessResumeRunStoreBinding } from "./runStoreBinding.ts";
import { authorizePublication, samePublisher, type Published } from "./authority.ts";
import {
  execute,
  fail,
  sameCheckpoint,
  sameSupervisor,
  sameVisibleState,
} from "./runStoreState.ts";

/** Bridges the first keyed process to A and the caller's independently owned RunStore. */
export function createInitialProcessAuthority(input: {
  readonly shard: HarnessProcessExecutionShardInput;
  readonly durable: HarnessDurableState;
  readonly assertOwned: () => void;
}) {
  const process = input.shard.processes[0];
  const descriptor = process?.journal;
  const runStore = snapshotHarnessProcessResumeRunStoreBinding(descriptor?.runStore);
  if (
    input.shard.processes.length !== 1 ||
    process === undefined ||
    descriptor === undefined ||
    runStore === undefined ||
    runStore.runId !== input.shard.runId ||
    runStore.processId !== process.processId ||
    runStore.transitionOperationId !== process.operationId ||
    runStore.currentPublisher.generation !== process.expectedFacetGeneration ||
    runStore.currentPublisher.facetNonce !== process.priorFacetNonce ||
    descriptor.publisher.generation !== process.expectedFacetGeneration ||
    descriptor.publisher.facetNonce !== process.priorFacetNonce ||
    runStore.checkpoint.native.id !== process.checkpointId ||
    runStore.checkpoint.filesystem.sha256 !== process.manifestRevision ||
    runStore.controlKey === input.shard.controllerClaim.controlKey ||
    runStore.supervisor.supervisorKey === input.shard.controllerClaim.controlKey
  )
    fail("input", "invalid-input");
  const journal: HarnessProcessExecutionJournal = {
    publisher: Object.freeze({ ...descriptor.publisher }),
    runStore,
  };
  let publication: Published | undefined;
  let preparedPublisher: typeof journal.publisher | undefined;
  let publicationAttempted = false;
  let activationRequest: HarnessProcessPublicationRequest | undefined;

  const preflight = async () => {
    input.assertOwned();
    const initial = await execute(
      input.durable.runStore,
      { type: "read", runId: input.shard.runId },
      "preflight",
    );
    const requests = initial.snapshot.requests;
    const facet = requests?.facets.at(-1);
    if (
      requests === undefined ||
      facet === undefined ||
      !sameSupervisor(initial.snapshot, runStore) ||
      facet.generation !== runStore.currentPublisher.generation ||
      facet.facetNonce !== runStore.currentPublisher.facetNonce ||
      facet.operationId !== runStore.processOperationId ||
      !sameCheckpoint(requests.checkpoint, runStore.checkpoint) ||
      requests.entries.some(
        (entry) => entry.status !== "completed" && entry.status !== "not-applied",
      ) ||
      requests.entries.some((entry) => entry.request.requestId === runStore.request.requestId)
    )
      fail("preflight", "request-changed");
    const authenticated = await execute(
      input.durable.runStore,
      {
        type: "request.replaceFacet",
        runId: input.shard.runId,
        controlKey: runStore.controlKey,
        expectedGeneration: facet.generation - 1,
        operationId: facet.operationId,
        facetNonce: facet.facetNonce,
        publisherKey: runStore.currentPublisher.publisherKey,
      },
      "preflight",
    );
    if (
      authenticated.action !== "unchanged" ||
      !sameVisibleState(initial.snapshot, authenticated.snapshot)
    )
      fail("preflight", "authority-changed");
    // This is a real journal intent and checks the current independent supervisor capability.
    await execute(
      input.durable.runStore,
      {
        type: "intent",
        runId: input.shard.runId,
        supervisor: runStore.supervisor,
        intent: {
          intentId: process.operationId,
          kind: "process-publication",
          reference: runStore.request.input,
        },
      },
      "preflight",
    );
    const current = await input.durable.threadSupervisor.execute({
      type: "read",
      runId: input.shard.runId,
      control: input.shard.controllerClaim,
    });
    input.assertOwned();
    if (
      (current.snapshot.lifecycle !== "stopped" && current.snapshot.lifecycle !== "settled") ||
      current.snapshot.admittedStepId !== null ||
      !samePublisher(current.currentPublisher, journal.publisher) ||
      current.snapshot.nativeSessionId !== process.nativeSessionId ||
      current.snapshot.checkpoint.checkpointId !== process.checkpointId ||
      current.snapshot.checkpoint.manifestSha256 !== process.manifestRevision
    )
      throw new Error(
        "Initial process publication requires the caller's settled A checkpoint and publisher.",
      );
    return current;
  };

  const authority: HarnessProcessExecutionSupervisorClient = {
    execute: async (command) => {
      await preflight();
      return input.durable.threadSupervisor.execute(command);
    },
    reconcileProcessFacetPublication: async (request) => {
      await input.durable.threadSupervisor.execute({
        type: "read",
        runId: input.shard.runId,
        control: request.controllerClaim,
      });
      // Uncertain old executions require an explicit repair. Opening a session does not authorize it.
      return { status: "unknown" };
    },
    publishProcessFacet: async (request) => {
      if (publicationAttempted)
        throw new Error("Initial process publication already has an owned attempt.");
      publicationAttempted = true;
      await preflight();
      input.assertOwned();
      if (
        request.operationId !== process.operationId ||
        request.expectedFacetGeneration !== process.expectedFacetGeneration ||
        request.priorFacetNonce !== process.priorFacetNonce ||
        request.nativeSessionId !== process.nativeSessionId ||
        request.checkpointId !== process.checkpointId ||
        request.manifestRevision !== process.manifestRevision
      )
        throw new Error("Initial process publication changed its descriptor.");
      preparedPublisher = {
        generation: process.expectedFacetGeneration + 1,
        facetNonce: request.identity.incarnationNonce,
        // @effect-diagnostics-next-line cryptoRandomUUID:off - this is a new A facet capability, separate from the caller's RunStore key.
        publisherKey: crypto.randomUUID().replaceAll("-", ""),
      };
      await input.durable.threadSupervisor.execute({
        type: "prepareFreshFacet",
        runId: input.shard.runId,
        control: input.shard.controllerClaim,
        publisher: journal.publisher,
        expectedGeneration: process.expectedFacetGeneration,
        operationId: process.operationId,
        preparedPublisher,
      });
      input.assertOwned();
      const result = await input.durable.publishFreshFacet({
        control: input.shard.controllerClaim,
        operationId: process.operationId,
        verifiedNativeSessionId: process.nativeSessionId,
        checkpoint: {
          checkpointId: process.checkpointId,
          manifestSha256: process.manifestRevision,
        },
      });
      if (result.status !== "published") throw new Error("Initial process publication is pending.");
      publication = result;
      activationRequest = request;
      return {
        publication: result,
        publisher: {
          generation: preparedPublisher.generation,
          facetNonce: preparedPublisher.facetNonce,
          publisherKey: runStore.nextPublisherKey,
        },
        requestId: runStore.request.requestId,
      };
    },
    authorizeProcessFacetActivation: async (request, receipt) => {
      input.assertOwned();
      if (
        publication === undefined ||
        publication.receipt !== receipt ||
        activationRequest !== request
      )
        throw new Error("Initial process activation has no owned publication receipt.");
      const replaced = await execute(
        input.durable.runStore,
        {
          type: "request.replaceFacet",
          runId: input.shard.runId,
          controlKey: runStore.controlKey,
          expectedGeneration: process.expectedFacetGeneration,
          operationId: process.operationId,
          facetNonce: request.identity.incarnationNonce,
          publisherKey: runStore.nextPublisherKey,
        },
        "replacement",
      );
      const facet = replaced.snapshot.requests?.facets.at(-1);
      if (
        replaced.action !== "recorded" ||
        facet?.operationId !== process.operationId ||
        facet.generation !== process.expectedFacetGeneration + 1 ||
        facet.facetNonce !== request.identity.incarnationNonce ||
        !sameCheckpoint(facet.checkpoint, runStore.checkpoint)
      )
        fail("replacement", "publisher-changed");
      const offered = await execute(
        input.durable.runStore,
        {
          type: "request.offer",
          runId: input.shard.runId,
          supervisor: runStore.supervisor,
          request: runStore.request,
        },
        "replacement",
      );
      if (offered.action !== "recorded") fail("replacement", "request-changed");
      await authorizePublication({
        durable: input.durable,
        runId: input.shard.runId,
        publication,
        request,
        lifecycle: "published",
      });
      input.assertOwned();
    },
  };
  return {
    authority,
    journal,
    async afterActivation() {
      if (
        publication === undefined ||
        preparedPublisher === undefined ||
        activationRequest === undefined
      )
        throw new Error("The initial process has no confirmed publication.");
      input.assertOwned();
      const activated = await input.durable.recordActivation({
        control: input.shard.controllerClaim,
        operationId: process.operationId,
      });
      if (activated.status !== "accepting") throw new Error("Initial A activation is pending.");
      const admitted = await input.durable.admitStep({
        control: input.shard.controllerClaim,
        stepId: runStore.request.requestId,
        expectedCheckpointId: process.checkpointId,
      });
      if (admitted.status !== "admitted")
        throw new Error("Initial A request admission is pending.");
      input.assertOwned();
      return {
        publication,
        publisher: preparedPublisher,
        request: runStore.request,
        runStorePublisher: {
          generation: preparedPublisher.generation,
          facetNonce: preparedPublisher.facetNonce,
          publisherKey: runStore.nextPublisherKey,
        },
      };
    },
  };
}
