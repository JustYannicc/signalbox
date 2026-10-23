import { DurableObject } from "cloudflare:workers";
import { HarnessProcessExecutionEntrypoint } from "../HarnessProcessExecutionEntrypoint.ts";
import { HarnessProcessPlacementStoreObject } from "../HarnessProcessPlacementStoreObject.ts";
import { deterministicShardOwner } from "./execution.ts";
import type { HarnessProcessExecutionEnvironment } from "./execution.ts";
import type {
  HarnessProcessControllerClaim,
  HarnessProcessExecutionShardInput,
  HarnessProcessPublication,
} from "../HarnessProcessPlacement.ts";

export { HarnessProcessExecutionEntrypoint, HarnessProcessPlacementStoreObject };

interface GateState {
  readonly expected: number;
  entered: number;
  readonly activeByContext: Map<string, number>;
  readonly peakByContext: Map<string, number>;
  readonly release: PromiseWithResolvers<void>;
}

export class ProcessPlacementGate extends DurableObject {
  #state: GateState | undefined;

  configure(expected: number) {
    if (!Number.isSafeInteger(expected) || expected <= 0) throw new TypeError("Invalid gate size");
    this.#state = {
      expected,
      entered: 0,
      activeByContext: new Map(),
      peakByContext: new Map(),
      release: Promise.withResolvers<void>(),
    };
  }

  async enter(requestContextId: string) {
    const state = this.#requireState();
    const active = (state.activeByContext.get(requestContextId) ?? 0) + 1;
    state.activeByContext.set(requestContextId, active);
    state.peakByContext.set(
      requestContextId,
      Math.max(active, state.peakByContext.get(requestContextId) ?? 0),
    );
    state.entered++;
    if (state.entered === state.expected) state.release.resolve();
    await state.release.promise;
  }

  leave(requestContextId: string) {
    const state = this.#requireState();
    state.activeByContext.set(
      requestContextId,
      (state.activeByContext.get(requestContextId) ?? 1) - 1,
    );
  }

  snapshot() {
    const state = this.#requireState();
    return {
      expected: state.expected,
      entered: state.entered,
      activeByContext: Object.fromEntries(state.activeByContext),
      peakByContext: Object.fromEntries(state.peakByContext),
    };
  }

  #requireState() {
    if (this.#state === undefined) throw new Error("Gate was not configured");
    return this.#state;
  }
}

export class ProcessPlacementLifecycle extends DurableObject {
  async invalidate() {}

  async reconcile() {
    return { acknowledged: true as const };
  }
}

interface ProcessPlacementEnvironment extends HarnessProcessExecutionEnvironment {
  readonly PLACEMENT_STORES: DurableObjectNamespace<HarnessProcessPlacementStoreObject>;
  readonly PROCESS_LIFECYCLE: DurableObjectNamespace<ProcessPlacementLifecycle>;
  readonly GATES: DurableObjectNamespace<ProcessPlacementGate>;
}

interface FixtureExports {
  readonly HarnessProcessExecutionEntrypoint: (options: {
    readonly props: Record<string, never>;
  }) => Pick<HarnessProcessExecutionEntrypoint, "runShard">;
}

const controllerClaim: HarnessProcessControllerClaim = {
  ownerId: "fixture-owner",
  incarnationId: "fixture-incarnation",
  epoch: 1,
  controlKey: "fixture-control-key-00000000000000000000000000000000",
};

const syntheticModule = `import { WorkerEntrypoint } from "cloudflare:workers";
export class SyntheticFacet extends WorkerEntrypoint {
  async prepareInert(input) {
    const { identity, nativeSessionId, checkpointId, manifestRevision } = input;
    return { nativeSessionId, checkpointId, manifestRevision, facetKey: identity.facetKey,
      incarnationNonce: identity.incarnationNonce, joined: { invocationRpc: true, fetch: true, ports: true } };
  }
  async activate(receipt) {
    if (receipt.status !== "confirmed") throw new Error("Synthetic facet got an unconfirmed receipt");
  }
  async invoke(input) {
    await this.env.GATE.enter(this.env.REQUEST_CONTEXT_ID);
    await this.env.GATE.leave(this.env.REQUEST_CONTEXT_ID);
    return { value: input.processId, stopAcknowledged: true,
      joined: { invocationRpc: true, fetch: true, ports: true } };
  }
  async stop() { return { acknowledged: true }; }
  async join() { return { invocationRpc: true, fetch: true, ports: true }; }
  async dispose() {}
}`;

export default {
  async fetch(request: Request, env: ProcessPlacementEnvironment, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/fence") return await fence(env);
    const { count } = (await request.json()) as { readonly count: number };
    if (!Number.isSafeInteger(count) || count <= 0)
      return new Response("bad count", { status: 400 });
    const gate = env.GATES.get(env.GATES.idFromName("overflow-fixture"));
    await gate.configure(count);
    const processes = Array.from({ length: count }, (_, index) => makeProcess(index));
    const input: HarnessProcessExecutionShardInput = {
      runId: "overflow-fixture",
      executionOperationId: "overflow-operation-r1",
      shardOwner: "fixture/run",
      shardIncarnationNonce: "fixture-shard-incarnation",
      controllerClaim,
      processes,
    };
    const exports = (ctx as unknown as { readonly exports: FixtureExports }).exports;
    const result = await exports.HarnessProcessExecutionEntrypoint({ props: {} }).runShard(input);
    return Response.json({ result, gate: await gate.snapshot() });
  },
};

function makeProcess(index: number) {
  const operationId = `process-operation-${index}`;
  const nativeSessionId = `native-session-${index}`;
  const checkpointId = `checkpoint-${index}`;
  const priorFacetNonce = `prior-facet-${index}`;
  const preparedFacetNonce = `prepared-facet-${index}`;
  const manifestRevision = index.toString(16).padStart(64, "0");
  const checkpoint = { checkpointId, manifestSha256: manifestRevision };
  const receipt = {
    operationId,
    fromGeneration: 1,
    toGeneration: 2,
    priorFacetNonce,
    preparedFacetNonce,
    checkpoint,
    status: "confirmed",
  } as const;
  const publication = {
    status: "published",
    receipt,
    files: { publication: receipt },
    supervisor: {
      action: "published",
      currentPublisher: {
        generation: 2,
        facetNonce: preparedFacetNonce,
        publisherKey: "fixture-publisher",
      },
      preparedPublisher: null,
      snapshot: {
        lifecycle: "published",
        ownerId: controllerClaim.ownerId,
        controlIncarnationId: controllerClaim.incarnationId,
        controlEpoch: controllerClaim.epoch,
        nativeSessionId,
        generation: 2,
        facetNonce: preparedFacetNonce,
        lastPublicationOperationId: operationId,
        checkpoint,
        lastPublication: {
          operationId,
          fromGeneration: 1,
          toGeneration: 2,
          priorFacetNonce,
          preparedFacetNonce,
          checkpoint,
        },
      },
    },
  } as unknown as HarnessProcessPublication;

  return {
    processId: `process-${index}`,
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
    modules: { "main.js": syntheticModule },
    entrypoint: "SyntheticFacet",
    input: { processId: `process-${index}` },
  };
}

async function fence(env: ProcessPlacementEnvironment) {
  const operationId = "fenced-operation";
  const shardIndex = 7;
  const owner = await deterministicShardOwner("fixture/fence", operationId, shardIndex);
  const store = env.PLACEMENT_STORES.get(env.PLACEMENT_STORES.idFromName(owner));
  const stale = {
    executionOperationId: operationId,
    shardIndex,
    shardIncarnationNonce: "old-incarnation",
    controllerClaim,
  };
  const retry = { ...stale, shardIncarnationNonce: "retry-incarnation" };
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
  return Response.json({ duplicateRejected, staleReleaseRejected, oldWriterRejected, owner });
}
