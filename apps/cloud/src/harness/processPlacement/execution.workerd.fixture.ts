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
  type HarnessProcessPlacementRecoveryRecord,
  type HarnessProcessPlacementWriter,
  type HarnessProcessPublication,
} from "../HarnessProcessPlacement.ts";
import type { ProcessSlotLeaseToken, ProcessSlotState } from "../../computer/ProcessSlots.ts";
import { syntheticFacetModule } from "./execution.workerd.syntheticFacet.ts";

export {
  HarnessProcessExecutionEntrypoint,
  HarnessProcessExecutionShardObject,
  HarnessProcessPlacementStoreObject,
};

const controllerClaim: HarnessProcessControllerClaim = {
  ownerId: "fixture-owner",
  incarnationId: "fixture-incarnation",
  epoch: 1,
  controlKey: "fixture-control-key-00000000000000000000000000000000",
};

export class ProcessPlacementSupervisor extends DurableObject {
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
}

interface ProcessPlacementEnvironment extends HarnessProcessExecutionEnvironment {
  readonly PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<HarnessProcessExecutionShardObject>;
  readonly PLACEMENT_STORES: DurableObjectNamespace<HarnessProcessPlacementStoreObject>;
  readonly HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace<ProcessPlacementSupervisor>;
}

interface FixtureExports {
  readonly HarnessProcessExecutionEntrypoint: (options: {
    readonly props: Record<string, never>;
  }) => Pick<HarnessProcessExecutionEntrypoint, "runShard">;
}

export default {
  async fetch(request: Request, env: ProcessPlacementEnvironment, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/fence") return await fence(env);
    if (path === "/duplicate") return await duplicate(env, ctx);
    if (path === "/unplaceable") return await unplaceableThenRetry(env, ctx);
    if (path === "/recover/start") return await recover(env, ctx, "start");
    if (path === "/recover/stale") return await recover(env, ctx, "stale");
    if (path === "/recover/retry") return await recover(env, ctx, "retry");
    return await overflow(request, env, ctx);
  },
};

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
    [makeProcess(0, "recovery", claim, action === "start" ? 2 : 0)],
    claim,
    "recovery-shard-incarnation",
  );
  try {
    const result = await runPublic(ctx, input);
    return Response.json({ action, result });
  } catch {
    return Response.json({
      action,
      staleRejected: action === "stale",
      recoverable: action === "retry",
    });
  }
}

async function fence(env: ProcessPlacementEnvironment) {
  const operationId = "fenced-operation";
  const owner = await deterministicShardOwner("fixture/fence", operationId, 7);
  const store = env.PLACEMENT_STORES.getByName(owner);
  const stale = writer(operationId, "old-incarnation");
  const retry = writer(operationId, "retry-incarnation");
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
  const writerA = writer(operationId, "writer-a", 8);
  const writerB = writer(operationId, "writer-b", 8);
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
    programCodeId: "fence-program",
    loaderId,
    facetKey: loaderId,
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
  shardIncarnationNonce = `${executionOperationId}-incarnation`,
): HarnessProcessExecutionShardInput {
  return {
    runId,
    executionOperationId,
    shardOwner,
    shardIncarnationNonce,
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
): HarnessProcessExecutionProcessInput {
  const processId = `${prefix}-${index}`;
  const operationId = `${prefix}-operation-${index}`;
  const nativeSessionId = `${prefix}-session-${index}`;
  const checkpointId = `${prefix}-checkpoint-${index}`;
  const priorFacetNonce = `${prefix}-prior-${index}`;
  const preparedFacetNonce = `${prefix}-prepared-${index}`;
  const manifestRevision = index.toString(16).padStart(64, "0");
  const publication = makePublication({
    claim,
    operationId,
    nativeSessionId,
    checkpointId,
    manifestRevision,
    priorFacetNonce,
    preparedFacetNonce,
  });
  return {
    processId,
    codeId: "synthetic",
    residentBytes: 1,
    nativeSessionId,
    checkpointId,
    manifestRevision,
    operationId,
    priorFacetNonce,
    preparedFacetNonce,
    expectedFacetGeneration: 1,
    publication,
    mainModule: "main.js",
    modules: { "main.js": syntheticFacetModule },
    entrypoint: "SyntheticFacet",
    facetEnv: { DISPOSAL_FAILURES: String(disposalFailures) },
    input: { processId },
  };
}

function makePublication(input: {
  readonly claim: HarnessProcessControllerClaim;
  readonly operationId: string;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly priorFacetNonce: string;
  readonly preparedFacetNonce: string;
}): HarnessProcessPublication {
  const receipt = {
    operationId: input.operationId,
    fromGeneration: 1,
    toGeneration: 2,
    priorFacetNonce: input.priorFacetNonce,
    preparedFacetNonce: input.preparedFacetNonce,
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
      currentPublisher: { generation: 2, facetNonce: input.preparedFacetNonce },
      snapshot: {
        lifecycle: "published",
        ownerId: input.claim.ownerId,
        controlIncarnationId: input.claim.incarnationId,
        controlEpoch: input.claim.epoch,
        nativeSessionId: input.nativeSessionId,
        checkpoint: receipt.checkpoint,
        generation: 2,
        facetNonce: input.preparedFacetNonce,
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
