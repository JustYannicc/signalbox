import type {
  HarnessProcessFacetLocator,
  HarnessProcessInvocationSettlement,
  HarnessProcessPlacementRequest,
  HarnessProcessPreparedFacet,
  HarnessProcessPublication,
  HarnessProcessPublicationReceipt,
  HarnessProcessPublicationRequest,
} from "../HarnessProcessPlacement.ts";

const joined = Object.freeze({ invocationRpc: true, fetch: true, ports: true });

export interface InvocationReadmissionInput {
  readonly requestId: string;
}

export function createReadmissionFacet(
  locator: HarnessProcessFacetLocator,
  nonce: string,
  request: HarnessProcessPlacementRequest,
  input: {
    readonly secondRequestId: string;
    readonly secondEntered: PromiseWithResolvers<void>;
    readonly releaseSecond: Promise<void>;
    readonly invocations: string[];
    readonly activationReceipts: HarnessProcessPublicationReceipt[];
  },
): HarnessProcessPreparedFacet<InvocationReadmissionInput> {
  return {
    async identity() {
      return { facetKey: locator.facetKey, incarnationNonce: nonce };
    },
    async prepareInert() {
      return {
        facetNonce: nonce,
        nativeSessionId: request.nativeSessionId,
        checkpoint: {
          native: { id: request.checkpointId, bytes: 1, sha256: "a".repeat(64) },
          filesystem: {
            id: `${request.checkpointId}-fs`,
            bytes: 1,
            sha256: request.manifestRevision,
          },
        },
        manifestRevision: request.manifestRevision,
        joined,
      };
    },
    async activate(receipt) {
      input.activationReceipts.push(receipt);
    },
    async invoke(invocation): Promise<HarnessProcessInvocationSettlement> {
      input.invocations.push(invocation.requestId);
      if (invocation.requestId === input.secondRequestId) {
        input.secondEntered.resolve();
        await input.releaseSecond;
      }
      return {
        value: invocation.requestId,
        stopAcknowledged: true,
        joined,
      };
    },
    async stop() {
      return { acknowledged: true };
    },
    async join() {
      return joined;
    },
    async dispose() {},
  };
}

export function readmissionPublicationFor(
  input: HarnessProcessPublicationRequest,
): HarnessProcessPublication {
  const receipt: HarnessProcessPublicationReceipt = {
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
    status: "published",
    control: input.controllerClaim,
    receipt,
    files: { publication: receipt },
    supervisor: {
      currentPublisher: {
        generation: receipt.toGeneration,
        facetNonce: input.identity.incarnationNonce,
      },
      snapshot: {
        lifecycle: "published",
        ownerId: input.controllerClaim.ownerId,
        controlIncarnationId: input.controllerClaim.incarnationId,
        controlEpoch: input.controllerClaim.epoch,
        nativeSessionId: input.nativeSessionId,
        checkpoint: receipt.checkpoint,
        generation: receipt.toGeneration,
        facetNonce: input.identity.incarnationNonce,
        lastPublicationOperationId: input.operationId,
        lastPublication,
      },
    },
  };
}
