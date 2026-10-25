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
    const events: string[] = [];
    const handle = await placement.prepareInert(request, (identity) =>
      testFacet(
        {
          async activate() {
            events.push("facet-activate");
          },
        },
        identity,
      ),
    );
    const publication = makePublication(request, handle.identity);
    await expect(
      handle.activate(
        publisherFor(request, handle.identity, publication, () => controllerClaim, events),
      ),
    ).resolves.toMatchObject({
      requestId: "fixture-request",
    });
    expect(events).toEqual(["authorize", "facet-activate"]);
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
      async authorizeProcessFacetActivation() {
        throw new Error("Authorization cannot follow a lost publication reply.");
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

  it("waits for capacity readmission before authorizing and fails closed on a takeover", async () => {
    const capacityBlocked = Promise.withResolvers<void>();
    const { placement } = await fixture({ onCapacity: () => capacityBlocked.resolve() });
    const events: string[] = [];
    const request = requestFor({ processId: "target-process", operationId: "target-operation" });
    const activated = vi.fn();
    const target = await placement.prepareInert(request, (identity) =>
      testFacet(
        {
          async activate() {
            activated();
          },
        },
        identity,
      ),
    );

    const occupiers = [];
    for (let index = 0; index < 4; index++) {
      const occupierRequest = requestFor({
        processId: `occupier-process-${index}`,
        operationId: `occupier-operation-${index}`,
      });
      const handle = await placement.prepareInert(occupierRequest, (identity) =>
        testFacet({}, identity),
      );
      await handle.activate(
        publisherFor(
          occupierRequest,
          handle.identity,
          makePublication(occupierRequest, handle.identity),
        ),
      );
      occupiers.push(handle);
    }

    let currentClaim = controllerClaim;
    let publishCalls = 0;
    let authorizationCalls = 0;
    const publisher = publisherFor(
      request,
      target.identity,
      makePublication(request, target.identity),
      () => currentClaim,
      events,
      {
        onPublish() {
          publishCalls++;
        },
        onAuthorize() {
          authorizationCalls++;
        },
      },
    );
    const activating = target.activate(publisher);
    await capacityBlocked.promise;
    expect(placement.signals.inFlight).toBe(4);
    expect({ authorizationCalls, events }).toEqual({ authorizationCalls: 0, events: [] });

    currentClaim = {
      ...controllerClaim,
      incarnationId: "takeover-incarnation",
      epoch: controllerClaim.epoch + 1,
      controlKey: "takeover-control-key",
    };
    await occupiers[0]!.cleanup();

    await expect(activating).rejects.toMatchObject({
      kind: "activation-failed",
      recoverable: true,
      details: { causeCode: "PUBLICATION_REQUIRES_REPAIR" },
    });
    const retained = (await placement.recoverable()).find(
      (record) => record.processId === "target-process",
    );
    expect(retained).toMatchObject({
      state: "activation-failed",
      publicationState: "confirmed",
      invocationMayHaveStarted: false,
      terminalFailure: { code: "PUBLICATION_REQUIRES_REPAIR" },
    });
    expect({ publishCalls, authorizationCalls, events }).toEqual({
      publishCalls: 1,
      authorizationCalls: 1,
      events: ["authorize"],
    });
    expect(activated).not.toHaveBeenCalled();
    expect(placement.signals.inFlight).toBe(4);
    expect(placement.signals.resident).toBe(4);
    await expect(target.activate(publisher)).rejects.toMatchObject({ kind: "activation-failed" });
    await expect(target.cleanup()).rejects.toMatchObject({ kind: "cleanup-incomplete" });
    expect({ publishCalls, authorizationCalls }).toEqual({
      publishCalls: 1,
      authorizationCalls: 1,
    });
    for (const handle of occupiers.slice(1)) await handle.cleanup();
  });

  it("keeps the confirmed non-runnable lease when the authorization recovery write fails", async () => {
    const { placement, recovery } = await fixture({ failActivationFailureWrite: true });
    const request = requestFor();
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
    let authorizationCalls = 0;
    const publisher = publisherFor(
      request,
      handle.identity,
      makePublication(request, handle.identity),
      () => ({
        ...controllerClaim,
        epoch: controllerClaim.epoch + 1,
        controlKey: "takeover-control-key",
      }),
      undefined,
      {
        onAuthorize() {
          authorizationCalls++;
        },
      },
    );

    await expect(handle.activate(publisher)).rejects.toMatchObject({
      kind: "activation-failed",
      recoverable: true,
    });
    await expect(handle.cleanup()).rejects.toMatchObject({ kind: "cleanup-incomplete" });
    expect(activated).not.toHaveBeenCalled();
    expect(authorizationCalls).toBe(1);
    expect(placement.signals).toMatchObject({ inFlight: 1, resident: 1 });
    expect([...recovery.values()]).toMatchObject([
      {
        state: "prepared",
        publicationState: "confirmed",
        invocationMayHaveStarted: false,
        publicationReceipt: { status: "confirmed" },
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

async function fixture(
  options: {
    readonly onCapacity?: () => void;
    readonly failActivationFailureWrite?: boolean;
  } = {},
) {
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
        if (options.failActivationFailureWrite && record.state === "activation-failed")
          throw new Error("Fixture lost the activation recovery write reply.");
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
    ...(options.onCapacity === undefined ? {} : { onCapacity: options.onCapacity }),
    invalidate() {},
    reconcile: async () => ({ acknowledged: true }),
  });
  return { placement, recovery };
}

function publisherFor(
  request: HarnessProcessPlacementRequest,
  identity: HarnessProcessPlacementIdentity,
  publication: HarnessProcessPublication,
  currentClaim: () => HarnessProcessControllerClaim = () => controllerClaim,
  events?: string[],
  callbacks: { readonly onPublish?: () => void; readonly onAuthorize?: () => void } = {},
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
  return {
    async publishProcessFacet() {
      callbacks.onPublish?.();
      return activation;
    },
    async authorizeProcessFacetActivation(input, confirmedReceipt) {
      callbacks.onAuthorize?.();
      events?.push("authorize");
      const actual = publication.receipt;
      const claim = currentClaim();
      if (
        publication.status !== "published" ||
        actual === null ||
        actual === undefined ||
        actual !== confirmedReceipt ||
        input.operationId !== request.operationId ||
        input.identity.incarnationNonce !== identity.incarnationNonce ||
        input.controllerClaim.ownerId !== claim.ownerId ||
        input.controllerClaim.incarnationId !== claim.incarnationId ||
        input.controllerClaim.epoch !== claim.epoch ||
        input.controllerClaim.controlKey !== claim.controlKey ||
        actual.toGeneration !== request.expectedFacetGeneration + 1 ||
        actual.preparedFacetNonce !== identity.incarnationNonce ||
        actual.checkpoint.checkpointId !== request.checkpointId ||
        actual.checkpoint.manifestSha256 !== request.manifestRevision
      )
        throw new Error("Fixture authority rejected the exact publication tuple.");
    },
  };
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
