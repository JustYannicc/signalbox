import { DurableObject } from "cloudflare:workers";
import { HarnessProcessExecutionEntrypoint } from "../HarnessProcessExecutionEntrypoint.ts";
import { HarnessProcessExecutionShardObject } from "../HarnessProcessExecutionShardObject.ts";
import { HarnessProcessPlacementStoreObject } from "../HarnessProcessPlacementStoreObject.ts";
import {
  deterministicShardOwner,
  type HarnessProcessControllerClaim,
  type HarnessProcessExecutionEnvironment,
  type HarnessProcessExecutionProcessInput,
  type HarnessProcessExecutionShardInput,
  type HarnessProcessPlacementIdentity,
  type HarnessProcessPublicationPublisher,
  type HarnessProcessPlacementRecoveryRecord,
  type HarnessProcessPlacementWriter,
  type HarnessProcessPublication,
  type HarnessProcessPublicationReconciliation,
  type HarnessProcessPublicationRequest,
  type HarnessProcessPublishedActivation,
} from "../HarnessProcessPlacement.ts";
import type { ProcessSlotLeaseToken, ProcessSlotState } from "../../computer/ProcessSlots.ts";
import { syntheticFacetModule } from "./execution.workerd.syntheticFacet.ts";
import {
  runProductionFacetProof,
  runIdentityReplyLossProof,
  sameKeyRequestFacetReconstruction,
  type ProductionFacetEnvironment,
  TestHarnessProcessRequestFacetObject,
} from "./productionFacet.workerd.fixture.ts";

export {
  HarnessProcessExecutionEntrypoint,
  HarnessProcessExecutionShardObject,
  HarnessProcessPlacementStoreObject,
  TestHarnessProcessRequestFacetObject,
};

const controllerClaim: HarnessProcessControllerClaim = {
  ownerId: "fixture-owner",
  incarnationId: "fixture-incarnation",
  epoch: 1,
  controlKey: "fixture-control-key-00000000000000000000000000000000",
};

export class ProcessPlacementSupervisor extends DurableObject {
  #dropPublicationReply = false;
  #publicationCalls = 0;
  #processInvocationCalls = 0;
  #heldInvocationBarrier:
    | {
        readonly expected: number;
        readonly entered: Map<string, Set<string>>;
        readonly ready: PromiseWithResolvers<
          ReadonlyArray<{ readonly requestContextId: string; readonly count: number }>
        >;
        readonly release: PromiseWithResolvers<void>;
      }
    | undefined;
  #readBarrier:
    | {
        readonly entered: PromiseWithResolvers<void>;
        readonly release: PromiseWithResolvers<void>;
      }
    | undefined;

  blockNextRead() {
    if (this.#readBarrier !== undefined)
      throw new Error("A supervisor read is already blocked in this fixture.");
    this.#readBarrier = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
  }

  async waitForBlockedRead() {
    if (this.#readBarrier === undefined)
      throw new Error("No supervisor read is armed in this fixture.");
    await this.#readBarrier.entered.promise;
  }

  releaseBlockedRead() {
    const barrier = this.#readBarrier;
    this.#readBarrier = undefined;
    barrier?.release.resolve();
  }

  armHeldInvocations(expected: number) {
    if (this.#heldInvocationBarrier !== undefined)
      throw new Error("A held invocation barrier is already armed in this fixture.");
    this.#heldInvocationBarrier = {
      expected,
      entered: new Map(),
      ready: Promise.withResolvers(),
      release: Promise.withResolvers(),
    };
  }

  async holdInvocation(requestContextId: string, processId: string) {
    const barrier = this.#heldInvocationBarrier;
    if (barrier === undefined) throw new Error("No held invocation barrier is armed.");
    let processes = barrier.entered.get(requestContextId);
    if (processes === undefined) {
      processes = new Set();
      barrier.entered.set(requestContextId, processes);
    }
    processes.add(processId);
    const count = [...barrier.entered.values()].reduce((total, ids) => total + ids.size, 0);
    if (count >= barrier.expected) {
      barrier.ready.resolve(
        [...barrier.entered].map(([id, ids]) => ({ requestContextId: id, count: ids.size })),
      );
    }
    await barrier.release.promise;
  }

  async waitForHeldInvocations() {
    const barrier = this.#heldInvocationBarrier;
    if (barrier === undefined) throw new Error("No held invocation barrier is armed.");
    return await barrier.ready.promise;
  }

  releaseHeldInvocations() {
    const barrier = this.#heldInvocationBarrier;
    this.#heldInvocationBarrier = undefined;
    barrier?.release.resolve();
  }

  async execute(input: {
    readonly type: "read";
    readonly runId: string;
    readonly control: HarnessProcessControllerClaim;
  }) {
    const barrier = this.#readBarrier;
    if (barrier !== undefined) {
      barrier.entered.resolve();
      await barrier.release.promise;
      if (this.#readBarrier === barrier) this.#readBarrier = undefined;
    }
    if (!input.runId || !sameClaim(input.control, controllerClaim))
      throw new Error("The fixture supervisor rejected a stale controller claim.");
    return {
      snapshot: {
        ownerId: controllerClaim.ownerId,
        controlIncarnationId: controllerClaim.incarnationId,
        controlEpoch: controllerClaim.epoch,
      },
    };
  }

  async publishProcessFacet(input: {
    readonly identity: HarnessProcessPlacementIdentity;
    readonly controllerClaim: HarnessProcessControllerClaim;
    readonly operationId: string;
    readonly nativeSessionId: string;
    readonly checkpointId: string;
    readonly manifestRevision: string;
    readonly priorFacetNonce: string;
    readonly expectedFacetGeneration: number;
  }): Promise<HarnessProcessPublishedActivation> {
    this.#publicationCalls++;
    if (!sameClaim(input.controllerClaim, controllerClaim))
      throw new Error("The fixture A publisher rejected a stale controller claim.");
    const publication = makePublication({ ...input, claim: input.controllerClaim });
    await this.ctx.storage.put(`publication-${input.operationId}`, publication);
    const activation = {
      publication,
      publisher: {
        generation: input.expectedFacetGeneration + 1,
        facetNonce: input.identity.incarnationNonce,
        publisherKey: `fixture-publisher-${input.identity.incarnationNonce}`,
      },
      requestId: `fixture-request-${input.operationId}`,
    };
    if (this.#dropPublicationReply) {
      this.#dropPublicationReply = false;
      throw new Error("Fixture dropped the committed publication reply.");
    }
    return activation;
  }

  dropNextPublicationReply() {
    this.#dropPublicationReply = true;
  }

  async noteProcessInvocation() {
    this.#processInvocationCalls++;
  }

  async publicationCallCount() {
    return this.#publicationCalls;
  }

  async processInvocationCount() {
    return this.#processInvocationCalls;
  }

  async reconcileProcessFacetPublication(
    input: HarnessProcessPublicationRequest,
  ): Promise<HarnessProcessPublicationReconciliation> {
    if (!sameClaim(input.controllerClaim, controllerClaim)) return { status: "unknown" };
    const publication = await this.ctx.storage.get<HarnessProcessPublication>(
      `publication-${input.operationId}`,
    );
    if (publication !== undefined) return { status: "published", publication };
    return {
      status: "not-published",
      controllerClaim: input.controllerClaim,
      operationId: input.operationId,
      currentPublisher: {
        generation: input.expectedFacetGeneration,
        facetNonce: input.priorFacetNonce,
      },
      lastPublicationOperationId: null,
    };
  }
}

export class TestHarnessProcessExecutionShardObject extends HarnessProcessExecutionShardObject {
  protected override processExecutionHooks() {
    const supervisor = this.env
      .HARNESS_THREAD_SUPERVISOR as unknown as DurableObjectNamespace<ProcessPlacementSupervisor>;
    return {
      beforeInvoke: async ({
        runId,
        processId,
        requestContextId,
      }: {
        readonly runId: string;
        readonly processId: string;
        readonly requestContextId: string;
      }) => {
        if (runId === "publication-reply-loss" || runId === "recovery-run") {
          await supervisor.getByName(runId).noteProcessInvocation();
          return;
        }
        if (runId === "direct-do-overflow")
          await supervisor.getByName(runId).holdInvocation(requestContextId, processId);
      },
    };
  }

  crashForTest() {
    this.ctx.abort("Fixture execution shard recreation proof.");
  }
}

interface ProcessPlacementEnvironment
  extends HarnessProcessExecutionEnvironment, ProductionFacetEnvironment {
  readonly PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<
    TestHarnessProcessExecutionShardObject & Rpc.DurableObjectBranded
  >;
  readonly PLACEMENT_STORES: DurableObjectNamespace<
    HarnessProcessPlacementStoreObject & Rpc.DurableObjectBranded
  >;
  readonly HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace<ProcessPlacementSupervisor>;
}

interface FixtureExports {
  readonly HarnessProcessExecutionEntrypoint: (options: {
    readonly props: Record<string, never>;
  }) => Pick<HarnessProcessExecutionEntrypoint, "runShard">;
}

interface PublicationLossShardClient {
  runShard(
    input: HarnessProcessExecutionShardInput,
    requestContextId: string,
  ): Promise<{
    readonly requestContextId: string;
    readonly processes: readonly {
      readonly status: string;
      readonly error?: { readonly kind: string };
    }[];
  }>;
  executionIncarnationNonce(): Promise<string>;
}

export default {
  async fetch(request: Request, env: ProcessPlacementEnvironment, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/recover-shard") return await recreateExecutionShard(env);
    if (path === "/do-overflow") return await runDirectDoOverflow(env);
    if (path === "/publication-reply-loss") return await publicationReplyLoss(env);
    if (path === "/production-facet") {
      const publisher = env.HARNESS_THREAD_SUPERVISOR.getByName(
        "production-process-facet-proof",
      ) as unknown as HarnessProcessPublicationPublisher;
      return await runProductionFacetProof(env, publisher, controllerClaim);
    }
    if (path === "/identity-reply-loss")
      return await runIdentityReplyLossProof(env, ctx, controllerClaim);
    if (path === "/same-key-reconstruction") return await sameKeyRequestFacetReconstruction(env);
    if (path === "/fence") return await fence(env);
    if (path === "/terminal-recovery") return await terminalRecovery(env, ctx);
    if (path === "/duplicate") return await duplicate(env, ctx);
    if (path === "/unplaceable") return await unplaceableThenRetry(env, ctx);
    if (path === "/recover/start") return await recover(env, ctx, "start");
    if (path === "/recover/stale") return await recover(env, ctx, "stale");
    if (path === "/recover/retry") return await recover(env, ctx, "retry");
    return await overflow(request, env, ctx);
  },
};

async function runDirectDoOverflow(env: ProcessPlacementEnvironment) {
  const runId = "direct-do-overflow";
  const operationId = "direct-do-overflow-operation";
  const supervisor = env.HARNESS_THREAD_SUPERVISOR.getByName(runId);
  supervisor.armHeldInvocations(21);
  const input = makeInput(
    runId,
    operationId,
    "fixture/direct-do-overflow",
    Array.from({ length: 21 }, (_, index) => {
      return makeProcess(index, "direct-do-overflow");
    }),
  );
  const owner = await deterministicShardOwner(input.shardOwner, operationId, 0);
  const running = env.PROCESS_EXECUTION_SHARDS.getByName(owner).runShard(
    input,
    "direct-do-request-context",
  );
  let contexts: readonly { readonly requestContextId: string; readonly count: number }[];
  try {
    contexts = await supervisor.waitForHeldInvocations();
  } finally {
    supervisor.releaseHeldInvocations();
  }
  return Response.json({ result: await running, contexts });
}

async function publicationReplyLoss(env: ProcessPlacementEnvironment) {
  const runId = "publication-reply-loss";
  const operationId = "publication-reply-loss-execution";
  const supervisor = env.HARNESS_THREAD_SUPERVISOR.getByName(runId);
  supervisor.dropNextPublicationReply();
  const input = makeInput(runId, operationId, "fixture/publication-reply-loss", [
    makeProcess(0, runId),
  ]);
  const owner = await deterministicShardOwner(input.shardOwner, operationId, 0);
  // The full fixture result carries an unknown settlement value; this route checks its status slice.
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(
    owner,
  ) as unknown as PublicationLossShardClient;
  const first = await shard.runShard(input, "first-publication-request");
  const second = await shard.runShard(input, "reconcile-publication-request");

  const shardNonce = await shard.executionIncarnationNonce();
  const currentWriter = writer(operationId, shardNonce, 0);
  const placementStore = env.PLACEMENT_STORES.getByName(owner);
  await placementStore.claimWriter(owner, currentWriter);
  const records = await placementStore.listRecovery(owner, currentWriter);
  const slotState = await placementStore.load(owner, currentWriter);
  await placementStore.releaseWriter(owner, currentWriter);
  const record = records[0];
  return Response.json({
    firstStatus: first.processes[0]?.status,
    firstKind: first.processes[0]?.error?.kind,
    secondStatus: second.processes[0]?.status,
    recoveryState: record?.state,
    publicationState: record?.publicationState,
    receiptOperationId: record?.publicationReceipt?.operationId,
    leaseStillHeld:
      record !== undefined &&
      slotState?.slots.some((slot) => slot.holder?.token === record.lease.token) === true,
    publisherCalls: await supervisor.publicationCallCount(),
    invocationCalls: await supervisor.processInvocationCount(),
  });
}

async function recreateExecutionShard(env: ProcessPlacementEnvironment) {
  const operationId = "recreated-execution-operation";
  const owner = await deterministicShardOwner("fixture/recreated-execution", operationId, 0);
  const execution = env.PROCESS_EXECUTION_SHARDS.getByName(owner);
  const originalNonce = await execution.executionIncarnationNonce();
  const store = env.PLACEMENT_STORES.getByName(owner);
  const originalWriter = writer(operationId, originalNonce, 0);
  const record = recoveryRecord(owner, originalWriter);
  const state: ProcessSlotState = {
    version: 1,
    owner,
    lost: 0,
    slots: [
      {
        codeId: record.lease.codeId,
        index: 0,
        generation: 0,
        holder: {
          token: record.lease.token,
          residentBytes: record.lease.residentBytes,
          permitted: true,
        },
      },
    ],
  };
  await store.claimWriter(owner, originalWriter);
  await store.save(owner, originalWriter, state);
  await store.saveRecovery(owner, originalWriter, record);
  try {
    await execution.crashForTest();
  } catch {
    // `crashForTest` aborts its Durable Object context, so this RPC is expected to reject.
  }

  const replacement = env.PROCESS_EXECUTION_SHARDS.getByName(owner);
  const replacementNonce = await replacement.executionIncarnationNonce();
  const replacementWriter = writer(operationId, replacementNonce, 0);
  let recoveryClaimed = false;
  try {
    await store.claimWriter(owner, replacementWriter);
    recoveryClaimed = true;
  } catch {}
  const recoveredState = recoveryClaimed ? await store.load(owner, replacementWriter) : undefined;
  const recoveredRecords = recoveryClaimed
    ? await store.listRecovery(owner, replacementWriter)
    : [];
  let oldWriterRejected = false;
  try {
    await store.save(owner, originalWriter, { ...state, lost: 1 });
  } catch {
    oldWriterRejected = true;
  }
  let liveDuplicateRejected = false;
  try {
    await store.claimWriter(owner, writer("live-duplicate", replacementNonce, 0));
  } catch {
    liveDuplicateRejected = true;
  }
  let exactRecoveryRemoved = false;
  if (recoveryClaimed) {
    await store.releaseWriter(owner, replacementWriter);
    await store.claimWriter(owner, replacementWriter);
    await store.removeRecovery(owner, replacementWriter, record.loaderId);
    exactRecoveryRemoved = (await store.listRecovery(owner, replacementWriter)).length === 0;
    await store.releaseWriter(owner, replacementWriter);
  }
  return Response.json({
    originalNonce,
    replacementNonce,
    recoveryClaimed,
    stateSurvived: JSON.stringify(recoveredState) === JSON.stringify(state),
    recoverySurvived:
      recoveredRecords.length === 1 && recoveredRecords[0]?.loaderId === record.loaderId,
    oldWriterRejected,
    liveDuplicateRejected,
    exactRecoveryRemoved,
  });
}

async function overflow(request: Request, env: ProcessPlacementEnvironment, ctx: ExecutionContext) {
  const { count } = (await request.json()) as { readonly count: number };
  if (!Number.isSafeInteger(count) || count <= 0) return new Response("bad count", { status: 400 });
  const input = makeInput(
    "overflow-run",
    "overflow-operation-r1",
    "fixture/overflow",
    Array.from({ length: count }, (_, index) => makeProcess(index, "overflow")),
  );
  const result = await runPublic(ctx, input);
  return Response.json({ result });
}

async function duplicate(env: ProcessPlacementEnvironment, ctx: ExecutionContext) {
  const supervisor = env.HARNESS_THREAD_SUPERVISOR.getByName("duplicate-run");
  await supervisor.blockNextRead();
  const input = makeInput("duplicate-run", "duplicate-operation", "fixture/duplicate", [
    makeProcess(0, "duplicate"),
  ]);
  const first = runPublic(ctx, input);
  await supervisor.waitForBlockedRead();
  const owner = await deterministicShardOwner(
    input.shardOwner,
    input.executionOperationId,
    input.shardIndex ?? 0,
  );
  const shard = env.PROCESS_EXECUTION_SHARDS.getByName(owner);
  let duplicateRejected = false;
  try {
    await shard.runShard(input, "duplicate-request-context");
  } catch {
    duplicateRejected = true;
  }
  await supervisor.releaseBlockedRead();
  const result = await first;
  return Response.json({ duplicateRejected, result });
}

async function unplaceableThenRetry(env: ProcessPlacementEnvironment, ctx: ExecutionContext) {
  const operationId = "unplaceable-operation";
  const first = makeInput("unplaceable-run", operationId, "fixture/unplaceable", [
    {
      ...makeProcess(0, "unplaceable-large"),
      residentBytes: 2 * 1024 * 1024,
    },
  ]);
  const firstResult = await runPublic(ctx, first);
  const retry = makeInput("unplaceable-run", operationId, "fixture/unplaceable", [
    makeProcess(1, "unplaceable-fit"),
  ]);
  const retryResult = await runPublic(ctx, retry);
  return Response.json({ firstResult, retryResult });
}

async function recover(
  env: ProcessPlacementEnvironment,
  ctx: ExecutionContext,
  action: "start" | "stale" | "retry",
) {
  const claim =
    action === "stale" ? { ...controllerClaim, controlKey: "stale-control-key" } : controllerClaim;
  const input = makeInput(
    "recovery-run",
    "recovery-operation",
    "fixture/recovery",
    [makeProcess(0, "recovery", claim, 2, 1)],
    claim,
  );
  try {
    const result = await runPublic(ctx, input);
    return Response.json({
      action,
      result,
      invocationCalls: await env.HARNESS_THREAD_SUPERVISOR.getByName(
        input.runId,
      ).processInvocationCount(),
    });
  } catch {
    return Response.json({
      action,
      staleRejected: action === "stale",
      recoverable: action === "retry",
      invocationCalls: await env.HARNESS_THREAD_SUPERVISOR.getByName(
        input.runId,
      ).processInvocationCount(),
    });
  }
}

async function terminalRecovery(env: ProcessPlacementEnvironment, ctx: ExecutionContext) {
  const input = makeInput(
    "terminal-recovery-run",
    "terminal-recovery-operation",
    "fixture/terminal-recovery",
    [makeProcess(0, "terminal-recovery", controllerClaim, 1, 0, 4)],
  );
  const failed = await runPublic(ctx, input);
  const repaired = await runPublic(ctx, input);
  const owner = await deterministicShardOwner(
    input.shardOwner,
    input.executionOperationId,
    input.shardIndex ?? 0,
  );
  const execution = env.PROCESS_EXECUTION_SHARDS.getByName(owner);
  const writerClaim = writer(
    input.executionOperationId,
    await execution.executionIncarnationNonce(),
    input.shardIndex ?? 0,
  );
  const store = env.PLACEMENT_STORES.getByName(owner);
  await store.claimWriter(owner, writerClaim);
  let slotsHeld: number;
  let recovery: readonly HarnessProcessPlacementRecoveryRecord[];
  try {
    const state = await store.load(owner, writerClaim);
    slotsHeld = state?.slots.filter((slot) => slot.holder !== undefined).length ?? 0;
    recovery = await store.listRecovery(owner, writerClaim);
  } finally {
    await store.releaseWriter(owner, writerClaim);
  }
  return Response.json({
    failed,
    repaired,
    slotsHeld,
    recovery: recovery.map((record) => ({
      loaderId: record.loaderId,
      state: record.state,
      stopAcknowledged: record.stopAcknowledged,
      joined: record.joined,
      terminalFailure: record.terminalFailure,
    })),
  });
}

async function fence(env: ProcessPlacementEnvironment) {
  const operationId = "fenced-operation";
  const owner = await deterministicShardOwner("fixture/fence", operationId, 7);
  const store = env.PLACEMENT_STORES.getByName(owner);
  const currentExecution = env.PROCESS_EXECUTION_SHARDS.getByName(owner);
  const liveNonce = await currentExecution.executionIncarnationNonce();
  const stale = writer(operationId, liveNonce);
  const retry = writer(`${operationId}-retry`, liveNonce);
  await store.claimWriter(owner, stale);
  let duplicateRejected = false;
  let staleReleaseRejected = false;
  try {
    await store.claimWriter(owner, retry);
  } catch {
    duplicateRejected = true;
  }
  try {
    await store.releaseWriter(owner, retry);
  } catch {
    staleReleaseRejected = true;
  }
  await store.releaseWriter(owner, stale);
  await store.claimWriter(owner, retry);
  let oldWriterRejected = false;
  try {
    await store.releaseWriter(owner, stale);
  } catch {
    oldWriterRejected = true;
  }
  await store.releaseWriter(owner, retry);

  const stateOwner = await deterministicShardOwner("fixture/stale-write", operationId, 8);
  const stateStore = env.PLACEMENT_STORES.getByName(stateOwner);
  const stateExecution = env.PROCESS_EXECUTION_SHARDS.getByName(stateOwner);
  const stateNonce = await stateExecution.executionIncarnationNonce();
  const writerA = writer(operationId, stateNonce, 8);
  const writerB = writer(`${operationId}-replacement`, stateNonce, 8);
  const stateA: ProcessSlotState = {
    version: 1,
    owner: stateOwner,
    lost: 0,
    slots: [],
  };
  const recordA = recoveryRecord(stateOwner, writerA);
  await stateStore.claimWriter(stateOwner, writerA);
  await stateStore.save(stateOwner, writerA, stateA);
  await stateStore.saveRecovery(stateOwner, writerA, recordA);
  await stateStore.releaseWriter(stateOwner, writerA);
  await stateStore.claimWriter(stateOwner, writerB);

  let staleSaveRejected = false;
  let staleRecoverySaveRejected = false;
  let staleRecoveryRemoveRejected = false;
  try {
    await stateStore.save(stateOwner, writerA, { ...stateA, lost: 1 });
  } catch {
    staleSaveRejected = true;
  }
  try {
    await stateStore.saveRecovery(stateOwner, writerA, { ...recordA, checkpointId: "stale-write" });
  } catch {
    staleRecoverySaveRejected = true;
  }
  try {
    await stateStore.removeRecovery(stateOwner, writerA, recordA.loaderId);
  } catch {
    staleRecoveryRemoveRejected = true;
  }
  const stateB = await stateStore.load(stateOwner, writerB);
  const recordsB = await stateStore.listRecovery(stateOwner, writerB);
  await stateStore.releaseWriter(stateOwner, writerB);
  return Response.json({
    duplicateRejected,
    staleReleaseRejected,
    oldWriterRejected,
    staleSaveRejected,
    staleRecoverySaveRejected,
    staleRecoveryRemoveRejected,
    stateUnchanged: JSON.stringify(stateB) === JSON.stringify(stateA),
    recoveryUnchanged: JSON.stringify(recordsB) === JSON.stringify([recordA]),
    owner,
  });
}

function writer(
  executionOperationId: string,
  shardIncarnationNonce: string,
  shardIndex = 7,
): HarnessProcessPlacementWriter {
  return { executionOperationId, shardIndex, shardIncarnationNonce, controllerClaim };
}

function recoveryRecord(
  shardOwner: string,
  owner: HarnessProcessPlacementWriter,
): HarnessProcessPlacementRecoveryRecord {
  const loaderId = `loader-${owner.shardIncarnationNonce}`;
  return {
    version: 1,
    shardOwner,
    controllerClaim,
    operationId: owner.executionOperationId,
    processId: "fence-process",
    nativeSessionId: "fence-session",
    checkpointId: "fence-checkpoint",
    manifestRevision: "a".repeat(64),
    priorFacetNonce: "fence-prior-nonce",
    expectedFacetGeneration: 1,
    programCodeId: "fence-program",
    loaderId,
    facetKey: loaderId,
    identityState: "observed",
    incarnationNonce: "fence-incarnation",
    lease: {
      token: "fence-lease" as ProcessSlotLeaseToken,
      loaderId,
      codeId: "fence-program",
      residentBytes: 1,
    },
    state: "cleanup-required",
    stopAcknowledged: false,
    joined: { invocationRpc: false, fetch: false, ports: false },
  };
}

async function runPublic(ctx: ExecutionContext, input: HarnessProcessExecutionShardInput) {
  const exports = (ctx as unknown as { readonly exports: FixtureExports }).exports;
  return await exports.HarnessProcessExecutionEntrypoint({ props: {} }).runShard(input);
}

function makeInput(
  runId: string,
  executionOperationId: string,
  shardOwner: string,
  processes: readonly HarnessProcessExecutionProcessInput[],
  controlClaim: HarnessProcessControllerClaim = controllerClaim,
): HarnessProcessExecutionShardInput {
  return {
    runId,
    executionOperationId,
    shardOwner,
    controllerClaim: controlClaim,
    shardIndex: 0,
    processes,
  };
}

function makeProcess(
  index: number,
  prefix: string,
  claim: HarnessProcessControllerClaim = controllerClaim,
  disposalFailures = 0,
  invocationFailures = 0,
  identityMismatchCall = 0,
): HarnessProcessExecutionProcessInput {
  const processId = `${prefix}-${index}`;
  const operationId = `${prefix}-operation-${index}`;
  const nativeSessionId = `${prefix}-session-${index}`;
  const checkpointId = `${prefix}-checkpoint-${index}`;
  const priorFacetNonce = `${prefix}-prior-${index}`;
  const manifestRevision = index.toString(16).padStart(64, "0");
  return {
    processId,
    codeId: "synthetic",
    residentBytes: 1,
    nativeSessionId,
    checkpointId,
    manifestRevision,
    operationId,
    priorFacetNonce,
    expectedFacetGeneration: 1,
    mainModule: "main.js",
    modules: { "main.js": syntheticFacetModule },
    entrypoint: "SyntheticFacet",
    facetEnv: {
      DISPOSAL_FAILURES: String(disposalFailures),
      INVOCATION_FAILURES: String(invocationFailures),
      IDENTITY_MISMATCH_CALL: String(identityMismatchCall),
    },
  };
}

function makePublication(input: {
  readonly claim: HarnessProcessControllerClaim;
  readonly identity: HarnessProcessPlacementIdentity;
  readonly operationId: string;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly priorFacetNonce: string;
  readonly expectedFacetGeneration: number;
}): HarnessProcessPublication {
  const receipt = {
    operationId: input.operationId,
    fromGeneration: input.expectedFacetGeneration,
    toGeneration: input.expectedFacetGeneration + 1,
    priorFacetNonce: input.priorFacetNonce,
    preparedFacetNonce: input.identity.incarnationNonce,
    checkpoint: {
      checkpointId: input.checkpointId,
      manifestSha256: input.manifestRevision,
    },
    status: "confirmed",
  } as const;
  return {
    status: "published",
    control: input.claim,
    receipt,
    files: { publication: receipt },
    supervisor: {
      currentPublisher: {
        generation: receipt.toGeneration,
        facetNonce: input.identity.incarnationNonce,
      },
      snapshot: {
        lifecycle: "published",
        ownerId: input.claim.ownerId,
        controlIncarnationId: input.claim.incarnationId,
        controlEpoch: input.claim.epoch,
        nativeSessionId: input.nativeSessionId,
        checkpoint: receipt.checkpoint,
        generation: receipt.toGeneration,
        facetNonce: input.identity.incarnationNonce,
        lastPublicationOperationId: input.operationId,
        lastPublication: receipt,
      },
    },
  };
}

function sameClaim(
  left: HarnessProcessControllerClaim,
  right: HarnessProcessControllerClaim,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.incarnationId === right.incarnationId &&
    left.epoch === right.epoch &&
    left.controlKey === right.controlKey
  );
}
