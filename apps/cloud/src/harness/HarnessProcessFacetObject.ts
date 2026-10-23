import type { HarnessRequestPublisher } from "./HarnessRunStore.ts";
import type { HarnessRequestFacetObject } from "./HarnessRequestFacetObject.ts";
import type {
  HarnessProcessFacetLocator,
  HarnessProcessJoined,
  HarnessProcessPlacementIdentity,
  HarnessProcessPreparedFacet,
  HarnessProcessPublicationReceipt,
} from "./processPlacement/contracts.ts";

const joinedAll: HarnessProcessJoined = Object.freeze({
  invocationRpc: true,
  fetch: true,
  ports: true,
});
const joinedInvocation: HarnessProcessJoined = Object.freeze({
  invocationRpc: true,
  fetch: false,
  ports: false,
});

export type HarnessProcessFacetRequestStub = Pick<HarnessRequestFacetObject, "run" | "dispose"> & {
  identity(): Promise<{ readonly facetNonce: string }> | { readonly facetNonce: string };
};

export interface HarnessProcessFacetPrepareInput {
  readonly identity: HarnessProcessPlacementIdentity;
  readonly operationId: string;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly priorFacetNonce: string;
  readonly expectedFacetGeneration: number;
}

export interface HarnessProcessFacetInvokeInput {
  readonly publisher: HarnessRequestPublisher;
  readonly requestId: string;
}

/** Add placement lifecycle rules around the real, constructor-owned Harness request facet. */
export function createHarnessProcessFacetAdapter(
  locator: HarnessProcessFacetLocator,
  facet: HarnessProcessFacetRequestStub,
): HarnessProcessPreparedFacet<HarnessProcessFacetInvokeInput> {
  let prepared:
    | {
        readonly operationId: string;
        readonly nativeSessionId: string;
        readonly checkpointId: string;
        readonly manifestRevision: string;
        readonly priorFacetNonce: string;
        readonly expectedFacetGeneration: number;
      }
    | undefined;
  let publication: HarnessProcessPublicationReceipt | undefined;
  let stopped = false;
  let stopAcknowledged = false;
  let disposed = false;
  let constructorNonce: string | undefined;
  let disposePromise: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();

  const identity = async (): Promise<HarnessProcessPlacementIdentity> => {
    const actual = await facet.identity();
    if (constructorNonce !== undefined && actual.facetNonce !== constructorNonce)
      throw new Error(
        "The Harness facet constructor identity changed during its retained lifetime.",
      );
    constructorNonce = actual.facetNonce;
    return Object.freeze({
      ...locator,
      incarnationNonce: actual.facetNonce,
    });
  };

  const dispose = async () => {
    if (disposed) return;
    const expectedNonce = constructorNonce ?? (await identity()).incarnationNonce;
    disposePromise ??= facet.dispose(expectedNonce).then(
      () => {
        disposed = true;
      },
      (cause: unknown) => {
        disposePromise = undefined;
        throw cause;
      },
    );
    await disposePromise;
  };

  return {
    identity: async () => {
      const actual = await identity();
      return { facetKey: actual.facetKey, incarnationNonce: actual.incarnationNonce };
    },
    async prepareInert(input: HarnessProcessFacetPrepareInput) {
      const actual = await identity();
      if (
        stopped ||
        !actual.incarnationNonce ||
        input.identity.shardOwner !== actual.shardOwner ||
        input.identity.loaderId !== actual.loaderId ||
        input.identity.facetKey !== actual.facetKey ||
        input.identity.incarnationNonce !== actual.incarnationNonce ||
        !input.operationId ||
        !input.nativeSessionId ||
        !input.checkpointId ||
        !input.manifestRevision ||
        !input.priorFacetNonce ||
        !Number.isSafeInteger(input.expectedFacetGeneration) ||
        input.expectedFacetGeneration < 0
      )
        throw new Error("Process facet preparation does not match its constructor identity.");

      const next = {
        operationId: input.operationId,
        nativeSessionId: input.nativeSessionId,
        checkpointId: input.checkpointId,
        manifestRevision: input.manifestRevision,
        priorFacetNonce: input.priorFacetNonce,
        expectedFacetGeneration: input.expectedFacetGeneration,
      };
      if (prepared !== undefined && !samePrepared(prepared, next))
        throw new Error("A process facet cannot be prepared for another operation.");
      prepared = next;
      return {
        nativeSessionId: next.nativeSessionId,
        checkpointId: next.checkpointId,
        manifestRevision: next.manifestRevision,
        facetKey: actual.facetKey,
        incarnationNonce: actual.incarnationNonce,
        joined: joinedAll,
      };
    },
    async activate(receipt) {
      const actual = await identity();
      const current = prepared;
      if (
        stopped ||
        current === undefined ||
        receipt.status !== "confirmed" ||
        receipt.operationId !== current.operationId ||
        receipt.fromGeneration !== current.expectedFacetGeneration ||
        receipt.toGeneration !== current.expectedFacetGeneration + 1 ||
        receipt.priorFacetNonce !== current.priorFacetNonce ||
        receipt.preparedFacetNonce !== actual.incarnationNonce ||
        receipt.checkpoint.checkpointId !== current.checkpointId ||
        receipt.checkpoint.manifestSha256 !== current.manifestRevision
      )
        throw new Error("Process facet activation lacks its actual published identity.");
      publication = receipt;
    },
    async invoke(input) {
      const actual = await identity();
      if (
        stopped ||
        publication === undefined ||
        input.publisher.generation !== publication.toGeneration ||
        input.publisher.facetNonce !== actual.incarnationNonce ||
        !input.publisher.publisherKey ||
        !input.requestId
      )
        throw new Error("Process facet invocation does not match its published request.");

      const running = facet.run({ publisher: input.publisher, requestId: input.requestId });
      active.add(running);
      try {
        return {
          value: await running,
          stopAcknowledged: false,
          joined: joinedInvocation,
        };
      } finally {
        active.delete(running);
      }
    },
    async stop() {
      stopped = true;
      try {
        // Runtime disposal waits for the retained request scope and its native finalizers.
        await dispose();
        stopAcknowledged = true;
        return { acknowledged: true };
      } catch {
        return { acknowledged: false };
      }
    },
    async join() {
      await Promise.allSettled(active);
      return disposed && stopAcknowledged && active.size === 0 ? joinedAll : joinedInvocation;
    },
    dispose,
  };
}

function samePrepared(
  left: {
    readonly operationId: string;
    readonly nativeSessionId: string;
    readonly checkpointId: string;
    readonly manifestRevision: string;
    readonly priorFacetNonce: string;
    readonly expectedFacetGeneration: number;
  },
  right: {
    readonly operationId: string;
    readonly nativeSessionId: string;
    readonly checkpointId: string;
    readonly manifestRevision: string;
    readonly priorFacetNonce: string;
    readonly expectedFacetGeneration: number;
  },
): boolean {
  return (
    left.operationId === right.operationId &&
    left.nativeSessionId === right.nativeSessionId &&
    left.checkpointId === right.checkpointId &&
    left.manifestRevision === right.manifestRevision &&
    left.priorFacetNonce === right.priorFacetNonce &&
    left.expectedFacetGeneration === right.expectedFacetGeneration
  );
}
