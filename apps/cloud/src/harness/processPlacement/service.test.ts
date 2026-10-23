import { describe, expect, it } from "vite-plus/test";
import type { ProcessSlotState, ProcessSlotStore } from "../../computer/ProcessSlots.ts";
import {
  createHarnessProcessPlacement,
  HarnessProcessPlacementError,
  type HarnessProcessControllerClaim,
  type HarnessProcessInvocationSettlement,
  type HarnessProcessPlacementIdentity,
  type HarnessProcessPlacementRecoveryRecord,
  type HarnessProcessPlacementRequest,
  type HarnessProcessPublication,
  type HarnessProcessPreparedFacet,
} from "../HarnessProcessPlacement.ts";

const controllerClaim: HarnessProcessControllerClaim = {
  ownerId: "owner",
  incarnationId: "claim-incarnation",
  epoch: 3,
  controlKey: "control-key",
};
const joined = { invocationRpc: true, fetch: true, ports: true } as const;
const joinedNone = { invocationRpc: false, fetch: false, ports: false } as const;

describe("harness process placement", () => {
  it("admits ten open calls in a DO context while the eleventh retains only residency", async () => {
    const { placement, state } = await fixture("durable-object");
    const count = 11;
    let open = 0;
    let peak = 0;
    const entered = Array.from({ length: count }, () => Promise.withResolvers<void>());
    const release = Array.from({ length: count }, () => Promise.withResolvers<void>());
    const requests = Array.from({ length: count }, (_, index) => requestFor(index));
    const handles = await Promise.all(
      requests.map((request, index) =>
        placement.prepareInert(request, () =>
          testFacet({
            async invoke(): Promise<HarnessProcessInvocationSettlement> {
              open++;
              peak = Math.max(peak, open);
              entered[index]!.resolve();
              await release[index]!.promise;
              open--;
              return { value: index, stopAcknowledged: true, joined };
            },
          }),
        ),
      ),
    );

    await Promise.all(
      handles
        .slice(0, 10)
        .map((handle, index) => handle.activate(publication(requests[index]!, handle.identity))),
    );
    const activationEleven = handles[10]!.activate(
      publication(requests[10]!, handles[10]!.identity),
    );
    const running = handles.slice(0, 10).map((handle, index) => handle.invoke({ index }));
    await Promise.all(entered.slice(0, 10).map((barrier) => barrier.promise));

    expect(peak).toBe(10);
    expect(open).toBe(10);
    expect(state.signals.inFlight).toBe(10);
    expect(state.signals.resident).toBe(11);

    release[0]!.resolve();
    await running[0];
    await handles[0]!.cleanup();
    await activationEleven;
    expect(state.signals.inFlight).toBe(10);
    const eleventh = handles[10]!.invoke({ index: 10 });
    await entered[10]!.promise;
    expect(peak).toBe(10);
    expect(open).toBe(10);

    for (let index = 1; index < count; index++) release[index]!.resolve();
    await Promise.all([...running.slice(1), eleventh]);
    await Promise.all(handles.slice(1).map((handle) => handle.cleanup()));
    expect(open).toBe(0);
    expect(state.signals.inFlight).toBe(0);
    expect(state.signals.resident).toBe(0);
  });

  it("removes an aborted capacity waiter before opening its facet", async () => {
    const { placement, state } = await fixture("durable-object");
    const requests = Array.from({ length: 10 }, (_, index) => requestFor(index));
    const handles = await Promise.all(
      requests.map((request) => placement.prepareInert(request, () => testFacet())),
    );
    await Promise.all(
      handles.map((handle, index) =>
        handle.activate(publication(requests[index]!, handle.identity)),
      ),
    );
    const abort = new AbortController();
    const blocked = requestFor(10);
    const request = { ...blocked, signal: abort.signal };
    let opened = false;
    const pending = placement.prepareInert(request, () => {
      opened = true;
      return testFacet();
    });

    expect(state.signals.inFlight).toBe(10);
    expect(state.signals.waiting).toBe(1);
    abort.abort();
    await expect(pending).rejects.toBe(abort.signal.reason);
    expect(state.signals.waiting).toBe(0);
    expect(opened).toBe(false);
    await Promise.all(handles.map((handle) => handle.cleanup()));
  });

  it("uses the public ProcessSlots park boundary and keeps an open invocation admitted", async () => {
    const { placement, state } = await fixture();
    const invocation =
      Promise.withResolvers<
        ReturnType<HarnessProcessPreparedFacet["invoke"]> extends Promise<infer Value>
          ? Value
          : never
      >();
    const invocationStarted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<{
      readonly value: string;
      readonly publication: HarnessProcessPublication;
    }>();
    const resumeStarted = Promise.withResolvers<void>();
    const facet = testFacet({
      async invoke() {
        invocationStarted.resolve();
        return await invocation.promise;
      },
    });
    const request = requestFor();
    const handle = await placement.prepareInert(request, () => facet);

    expect(state.signals.inFlight).toBe(0);
    expect(state.signals.resident).toBe(1);
    await handle.activate(publication(request, handle.identity));
    expect(state.signals.inFlight).toBe(1);

    const running = handle.invoke({});
    await invocationStarted.promise;
    await expect(
      handle.park(() => resume.promise, new AbortController().signal),
    ).rejects.toMatchObject({
      kind: "invocation-unsettled",
    });
    expect(state.signals.inFlight).toBe(1);

    invocation.resolve({ value: "suspended", stopAcknowledged: true, joined });
    await running;
    const parked = handle.park(() => {
      resumeStarted.resolve();
      return resume.promise;
    }, new AbortController().signal);
    await resumeStarted.promise;
    expect(state.signals.inFlight).toBe(0);
    expect(state.signals.resident).toBe(1);

    resume.resolve({ value: "resumed", publication: publication(request, handle.identity) });
    await expect(parked).resolves.toBe("resumed");
    expect(state.signals.inFlight).toBe(1);
    await handle.cleanup();
    expect(state.signals.inFlight).toBe(0);
    expect(state.signals.resident).toBe(0);
  });

  it("returns an explicit recoverable route when a process cannot fit this shard", async () => {
    const { placement, state } = await fixture();
    let opened = false;
    const request = { ...requestFor(), residentBytes: 101 };
    await expect(
      placement.prepareInert(request, () => {
        opened = true;
        return testFacet();
      }),
    ).rejects.toMatchObject({
      kind: "unplaceable",
      recoverable: true,
      details: { route: "different-destination-required" },
    } satisfies Partial<HarnessProcessPlacementError>);
    expect(opened).toBe(false);
    expect(state.signals.inFlight).toBe(0);
    expect(state.signals.resident).toBe(0);
  });

  it("retains the lease and recovery record until stop and joined settlement are confirmed", async () => {
    const { placement, recovery } = await fixture();
    let stopAcknowledged = false;
    let fullyJoined = false;
    const request = requestFor();
    const handle = await placement.prepareInert(request, () =>
      testFacet({
        async stop() {
          return { acknowledged: stopAcknowledged };
        },
        async join() {
          return fullyJoined ? joined : joinedNone;
        },
      }),
    );
    await handle.activate(publication(request, handle.identity));

    await expect(handle.cleanup()).rejects.toMatchObject({
      kind: "cleanup-incomplete",
      recoverable: true,
    });
    expect(placement.signals.resident).toBe(1);
    expect(placement.signals.inFlight).toBe(1);
    expect([...recovery.values()]).toMatchObject([{ state: "cleanup-required" }]);

    stopAcknowledged = true;
    fullyJoined = true;
    await handle.cleanup();
    expect(placement.signals.resident).toBe(0);
    expect(placement.signals.inFlight).toBe(0);
    expect(recovery.size).toBe(0);
  });

  it("retries recovery-record removal after releasing a settled lease", async () => {
    let failRemoval = true;
    const { placement, recovery } = await fixture("worker-request", () => {
      if (failRemoval) {
        failRemoval = false;
        throw new Error("temporary storage failure");
      }
    });
    const request = requestFor();
    const handle = await placement.prepareInert(request, () => testFacet());
    await handle.activate(publication(request, handle.identity));

    await expect(handle.cleanup()).rejects.toMatchObject({ kind: "cleanup-incomplete" });
    expect(placement.signals.inFlight).toBe(0);
    expect(placement.signals.resident).toBe(0);
    expect([...recovery.values()]).toMatchObject([{ state: "cleanup-required" }]);

    await handle.cleanup();
    expect(recovery.size).toBe(0);
  });

  it("keeps a cleanly disposed activation failure visible for repair", async () => {
    const { placement, recovery } = await fixture();
    const request = requestFor();
    const handle = await placement.prepareInert(request, () =>
      testFacet({
        async activate() {
          throw new Error("activation failed");
        },
      }),
    );

    await expect(handle.activate(publication(request, handle.identity))).rejects.toMatchObject({
      kind: "activation-failed",
      recoverable: true,
    });
    await handle.cleanup();
    expect([...recovery.values()]).toMatchObject([{ state: "activation-failed" }]);
    expect(placement.signals.inFlight).toBe(0);
    expect(placement.signals.resident).toBe(0);
  });
});

async function fixture(
  context: "durable-object" | "worker-request" = "worker-request",
  beforeRemove?: (loaderId: string) => void,
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
    context,
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
        beforeRemove?.(loaderId);
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
  return { placement, state: placement, recovery };
}

function requestFor(index = 0): HarnessProcessPlacementRequest {
  return {
    codeId: "program",
    residentBytes: 10,
    nativeSessionId: `native-session-${index}`,
    checkpointId: `checkpoint-${index}`,
    manifestRevision: index.toString(16).padStart(64, "0"),
    priorFacetNonce: `prior-facet-nonce-${index}`,
    preparedFacetNonce: `prepared-facet-nonce-${index}`,
    controllerClaim,
    operationId: `operation-${index}`,
    expectedFacetGeneration: 3,
    signal: new AbortController().signal,
  };
}

function publication(
  request: HarnessProcessPlacementRequest,
  identity: HarnessProcessPlacementIdentity,
): HarnessProcessPublication {
  const receipt = {
    operationId: request.operationId,
    fromGeneration: request.expectedFacetGeneration,
    toGeneration: request.expectedFacetGeneration + 1,
    priorFacetNonce: request.priorFacetNonce,
    preparedFacetNonce: identity.incarnationNonce,
    checkpoint: {
      checkpointId: request.checkpointId,
      manifestSha256: request.manifestRevision,
    },
    status: "confirmed",
  } as const;
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
    receipt,
    files: { publication: receipt },
    supervisor: {
      currentPublisher: {
        generation: receipt.toGeneration,
        facetNonce: identity.incarnationNonce,
      },
      snapshot: {
        lifecycle: "published",
        ownerId: controllerClaim.ownerId,
        controlIncarnationId: controllerClaim.incarnationId,
        controlEpoch: controllerClaim.epoch,
        nativeSessionId: request.nativeSessionId,
        checkpoint: receipt.checkpoint,
        generation: receipt.toGeneration,
        facetNonce: identity.incarnationNonce,
        lastPublicationOperationId: receipt.operationId,
        lastPublication,
      },
    },
  };
}

function testFacet(
  overrides: Partial<HarnessProcessPreparedFacet<unknown>> = {},
): HarnessProcessPreparedFacet<unknown> {
  return {
    async prepareInert(input) {
      return {
        nativeSessionId: input.nativeSessionId,
        checkpointId: input.checkpointId,
        manifestRevision: input.manifestRevision,
        facetKey: input.identity.facetKey,
        incarnationNonce: input.identity.incarnationNonce,
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
