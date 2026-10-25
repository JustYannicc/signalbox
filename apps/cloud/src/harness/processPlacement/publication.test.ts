import { describe, expect, it, vi } from "vite-plus/test";
import type { ProcessSlotState, ProcessSlotStore } from "../../computer/ProcessSlots.ts";
import {
  createHarnessProcessPlacement,
  type HarnessProcessControllerClaim,
  type HarnessProcessPlacementIdentity,
  type HarnessProcessPlacementRecoveryRecord,
  type HarnessProcessPlacementRequest,
  type HarnessProcessPreparedFacet,
  type HarnessProcessPublication,
  type HarnessProcessPublicationPublisher,
  type HarnessProcessPublishedActivation,
  type HarnessProcessPublicationReceipt,
} from "../HarnessProcessPlacement.ts";

const controllerClaim: HarnessProcessControllerClaim = {
  ownerId: "owner",
  incarnationId: "claim-incarnation",
  epoch: 3,
  controlKey: "control-key",
};
const joined = { invocationRpc: true, fetch: true, ports: true } as const;
let nextFacetNonce = 0;
type ReceiptChange = Omit<Partial<HarnessProcessPublicationReceipt>, "checkpoint"> & {
  readonly checkpoint?: Partial<HarnessProcessPublicationReceipt["checkpoint"]>;
};

interface PublicationMismatch {
  readonly name: string;
  readonly control?: Partial<HarnessProcessControllerClaim>;
  readonly receipt?: ReceiptChange;
  readonly manifestRevision?: string;
  readonly outerStatus?: "supervisor-pending";
}

const mismatches: readonly PublicationMismatch[] = [
  { name: "controller control key", control: { controlKey: "different-control-key" } },
  { name: "operation id", receipt: { operationId: "other-operation" } },
  { name: "exact from generation", receipt: { fromGeneration: 2 } },
  { name: "exact to generation", receipt: { toGeneration: 5 } },
  { name: "prior facet nonce", receipt: { priorFacetNonce: "other-prior" } },
  { name: "prepared facet nonce", receipt: { preparedFacetNonce: "other-prepared" } },
  { name: "checkpoint id", receipt: { checkpoint: { checkpointId: "other-checkpoint" } } },
  { name: "checkpoint hash", receipt: { checkpoint: { manifestSha256: "b".repeat(64) } } },
  { name: "manifest revision", manifestRevision: "c".repeat(64) },
  { name: "pending outer publication", outerStatus: "supervisor-pending" },
  { name: "unconfirmed files receipt", receipt: { status: "pending" } },
];

describe("composed process publication receipt", () => {
  it("accepts A's complete confirmed receipt and keeps its receipt object intact", async () => {
    const request = requestFor();
    const { placement } = await fixture();
    const handle = await placement.prepareInert(request, (identity) => testFacet({}, identity));
    const publication = makePublication(request, handle.identity);
    await expect(
      handle.activate(publisherFor(request, handle.identity, publication)),
    ).resolves.toMatchObject({
      requestId: "fixture-request",
    });
    expect(publication.receipt?.status).toBe("confirmed");
    await handle.cleanup();
  });

  it.each(mismatches)("rejects a $name mismatch before facet activation", async (change) => {
    const request =
      change.manifestRevision === undefined
        ? requestFor()
        : requestFor({ manifestRevision: change.manifestRevision });
    const { placement, recovery } = await fixture();
    const activated = vi.fn();
    const handle = await placement.prepareInert(request, (identity) =>
      testFacet(
        {
          async activate() {
            activated();
          },
        },
        identity,
      ),
    );
    const publication = makePublication(request, handle.identity, change);

    await expect(
      handle.activate(publisherFor(request, handle.identity, publication)),
    ).rejects.toMatchObject({ kind: "publication-unknown", recoverable: true });
    expect(activated).not.toHaveBeenCalled();
    expect(placement.signals.inFlight).toBe(0);
    expect(placement.signals.resident).toBe(1);
    expect([...recovery.values()]).toMatchObject([
      { publicationState: change.outerStatus === "supervisor-pending" ? "pending" : "unknown" },
    ]);
  });

  it("persists publication-in-progress before the publisher and retains ownership on reply loss", async () => {
    const request = requestFor();
    const { placement, recovery } = await fixture();
    let stopCalls = 0;
    let disposeCalls = 0;
    let publisherCalls = 0;
    const handle = await placement.prepareInert(request, (identity) =>
      testFacet(
        {
          async stop() {
            stopCalls++;
            return { acknowledged: true };
          },
          async dispose() {
            disposeCalls++;
          },
        },
        identity,
      ),
    );
    const publisher: HarnessProcessPublicationPublisher = {
      async publishProcessFacet(input) {
        publisherCalls++;
        expect(input.operationId).toBe(request.operationId);
        expect([...recovery.values()]).toMatchObject([
          { state: "prepared", publicationState: "in-progress" },
        ]);
        throw new Error("Committed publisher response was lost.");
      },
    };

    await expect(handle.activate(publisher)).rejects.toMatchObject({
      kind: "publication-unknown",
      recoverable: true,
      details: { publicationState: "unknown" },
    });
    await expect(handle.cleanup()).rejects.toMatchObject({
      kind: "cleanup-incomplete",
      recoverable: true,
    });
    expect({ publisherCalls, stopCalls, disposeCalls }).toEqual({
      publisherCalls: 1,
      stopCalls: 0,
      disposeCalls: 0,
    });
    expect(placement.signals.resident).toBe(1);
    expect(placement.signals.inFlight).toBe(0);
    expect([...recovery.values()]).toMatchObject([
      {
        state: "prepared",
        publicationState: "unknown",
        identityState: "observed",
        incarnationNonce: handle.identity.incarnationNonce,
      },
    ]);
  });
});

function requestFor(
  overrides: Partial<HarnessProcessPlacementRequest> = {},
): HarnessProcessPlacementRequest {
  return {
    processId: "process",
    codeId: "program",
    residentBytes: 10,
    nativeSessionId: "native-session",
    checkpointId: "checkpoint",
    manifestRevision: "a".repeat(64),
    priorFacetNonce: "prior-nonce",
    controllerClaim,
    operationId: "operation",
    expectedFacetGeneration: 3,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makePublication(
  request: HarnessProcessPlacementRequest,
  identity: HarnessProcessPlacementIdentity,
  change: PublicationMismatch = { name: "valid" },
): HarnessProcessPublication {
  const receiptChange = change.receipt;
  const receipt: HarnessProcessPublicationReceipt = {
    operationId: receiptChange?.operationId ?? request.operationId,
    fromGeneration: receiptChange?.fromGeneration ?? request.expectedFacetGeneration,
    toGeneration: receiptChange?.toGeneration ?? request.expectedFacetGeneration + 1,
    priorFacetNonce: receiptChange?.priorFacetNonce ?? request.priorFacetNonce,
    preparedFacetNonce: receiptChange?.preparedFacetNonce ?? identity.incarnationNonce,
    checkpoint: {
      checkpointId: request.checkpointId,
      manifestSha256:
        change.manifestRevision === undefined ? request.manifestRevision : "a".repeat(64),
      ...receiptChange?.checkpoint,
    },
    status: receiptChange?.status ?? "confirmed",
  };
  const lastPublication = {
    operationId: receipt.operationId,
    fromGeneration: receipt.fromGeneration,
    toGeneration: receipt.toGeneration,
    priorFacetNonce: receipt.priorFacetNonce,
    preparedFacetNonce: receipt.preparedFacetNonce,
    checkpoint: receipt.checkpoint,
  };
  return {
    status: change.outerStatus ?? "published",
    ...(change.outerStatus === undefined
      ? { control: { ...controllerClaim, ...change.control } }
      : {}),
    receipt,
    files: { publication: receipt },
    supervisor: {
      currentPublisher: {
        generation: receipt.toGeneration,
        facetNonce: receipt.preparedFacetNonce,
      },
      snapshot: {
        lifecycle: "published",
        ownerId: controllerClaim.ownerId,
        controlIncarnationId: controllerClaim.incarnationId,
        controlEpoch: controllerClaim.epoch,
        nativeSessionId: request.nativeSessionId,
        checkpoint: receipt.checkpoint,
        generation: receipt.toGeneration,
        facetNonce: receipt.preparedFacetNonce,
        lastPublicationOperationId: receipt.operationId,
        lastPublication,
      },
    },
  };
}

async function fixture() {
  let saved: ProcessSlotState | undefined;
  const store: ProcessSlotStore = {
    load: async () => saved,
    save: async (next) => {
      saved = next;
    },
  };
  const recovery = new Map<string, HarnessProcessPlacementRecoveryRecord>();
  const placement = await createHarnessProcessPlacement({
    owner: "test/shard",
    contextKey: {},
    context: "worker-request",
    shardIncarnationNonce: "request-incarnation",
    controllerClaim,
    residentByteLimit: 100,
    store,
    recovery: {
      list: async () => [...recovery.values()],
      save: async (record) => {
        recovery.set(record.loaderId, record);
      },
      remove: async (loaderId) => {
        recovery.delete(loaderId);
      },
    },
    scheduleQuantum(callback) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) callback();
      });
      return () => {
        cancelled = true;
      };
    },
    invalidate() {},
    reconcile: async () => ({ acknowledged: true }),
  });
  return { placement, recovery };
}

function publisherFor(
  request: HarnessProcessPlacementRequest,
  identity: HarnessProcessPlacementIdentity,
  publication: HarnessProcessPublication,
): HarnessProcessPublicationPublisher {
  const activation: HarnessProcessPublishedActivation = {
    publication,
    publisher: {
      generation: request.expectedFacetGeneration + 1,
      facetNonce: identity.incarnationNonce,
      publisherKey: "fixture-publisher-key",
    },
    requestId: "fixture-request",
  };
  return { publishProcessFacet: async () => activation };
}

function testFacet(
  overrides: Partial<HarnessProcessPreparedFacet<unknown>> = {},
  locator: Omit<HarnessProcessPlacementIdentity, "incarnationNonce">,
): HarnessProcessPreparedFacet<unknown> {
  const identity: HarnessProcessPlacementIdentity = {
    ...locator,
    incarnationNonce: `fixture-facet-${++nextFacetNonce}`,
  };
  return {
    async identity() {
      return { facetKey: identity.facetKey, incarnationNonce: identity.incarnationNonce };
    },
    async prepareInert(input) {
      return {
        facetNonce: input.targetFacetNonce,
        nativeSessionId: input.nativeSessionId,
        checkpoint: {
          native: { id: input.checkpointId, bytes: 0, sha256: "0".repeat(64) },
          filesystem: {
            id: `${input.checkpointId}-filesystem`,
            bytes: 0,
            sha256: input.manifestRevision,
          },
        },
        manifestRevision: input.manifestRevision,
        joined,
      };
    },
    async activate() {},
    async invoke(input) {
      return { value: input, stopAcknowledged: true, joined };
    },
    async stop() {
      return { acknowledged: true };
    },
    async join() {
      return joined;
    },
    async dispose() {},
    ...overrides,
  };
}
