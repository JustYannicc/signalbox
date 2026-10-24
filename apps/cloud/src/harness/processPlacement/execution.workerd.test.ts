// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - this proof invokes the public Worker entrypoint in local workerd.
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "harness-process-placement-proof",
        main: NodeURL.fileURLToPath(new URL("./execution.workerd.fixture.ts", import.meta.url)),
        compatibility_date: "2026-10-19",
        compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
        vars: { RESIDENT_BYTE_LIMIT: "1048576" },
        worker_loaders: [{ binding: "LOADER" }],
        durable_objects: {
          bindings: [
            {
              name: "PROCESS_EXECUTION_SHARDS",
              class_name: "TestHarnessProcessExecutionShardObject",
            },
            { name: "PLACEMENT_STORES", class_name: "HarnessProcessPlacementStoreObject" },
            { name: "HARNESS_RUN_STORES", class_name: "HarnessRunStoreObject" },
            { name: "HARNESS_THREAD_SUPERVISOR", class_name: "ProcessPlacementSupervisor" },
            { name: "PROCESS_TEST_FACETS", class_name: "TestHarnessProcessRequestFacetObject" },
            {
              name: "PROCESS_RUN_STORE_FACETS",
              class_name: "TestHarnessProcessRunStoreRequestFacetObject",
            },
          ],
        },
        migrations: [
          {
            tag: "v1",
            new_sqlite_classes: [
              "TestHarnessProcessExecutionShardObject",
              "HarnessProcessPlacementStoreObject",
              "HarnessRunStoreObject",
              "ProcessPlacementSupervisor",
              "TestHarnessProcessRequestFacetObject",
              "TestHarnessProcessRunStoreRequestFacetObject",
            ],
          },
        ],
      },
    },
  ],
});

beforeAll(() => harness.listen(), 60_000);
afterAll(() => harness.close());

describe("process execution Worker entrypoint", () => {
  it("routes a direct DO request with 21 held children through disjoint overflow identities", async () => {
    const response = await harness.fetch("/do-overflow");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly contexts: readonly { readonly requestContextId: string; readonly count: number }[];
      readonly result: {
        readonly processes: readonly {
          readonly processId: string;
          readonly requestContextId: string;
          readonly identity: { readonly loaderId: string; readonly shardOwner: string } | null;
          readonly status: string;
        }[];
      };
    };
    const contexts = result.contexts;
    const processes = result.result.processes;
    expect(processes).toHaveLength(21);
    expect(contexts.reduce((total, { count }) => total + count, 0)).toBe(21);
    expect(contexts).toHaveLength(5);
    expect(processes.every((process) => process.status === "settled")).toBe(true);
    expect(processes.every((process) => process.identity !== null)).toBe(true);
    expect(new Set(processes.map((process) => process.identity!.loaderId)).size).toBe(21);
    expect(new Set(processes.map((process) => process.identity!.shardOwner)).size).toBe(5);
    expect(new Set(processes.map((process) => process.requestContextId)).size).toBe(5);
    const perRequest = new Map<string, number>();
    const perOwner = new Map<string, number>();
    for (const process of processes)
      perRequest.set(process.requestContextId, (perRequest.get(process.requestContextId) ?? 0) + 1);
    for (const process of processes) {
      const owner = process.identity!.shardOwner;
      perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
    }
    expect([...perRequest.values()].sort((left, right) => right - left)).toEqual([10, 4, 4, 2, 1]);
    expect([...perOwner.values()].sort((left, right) => right - left)).toEqual([10, 4, 4, 2, 1]);
  }, 120_000);

  it("adapts the retained production Harness request facet through its constructor identity and scope", async () => {
    const response = await harness.fetch("/production-facet");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly constructorNonce: string;
      readonly publishedNonce: string;
      readonly action: string;
      readonly lifecycle: {
        readonly legacyOpenCalled: boolean;
        readonly preparedRuntimeClosed: boolean;
        readonly preparedRuntimeInvoked: boolean;
        readonly requestFacetDisposed: boolean;
        readonly prepareInertCalls: number;
        readonly settled: {
          readonly invocationRpc: boolean;
          readonly fetch: boolean;
          readonly ports: boolean;
        };
      };
      readonly inFlight: number;
      readonly resident: number;
    };
    expect(result.constructorNonce).toBeTruthy();
    expect(result.publishedNonce).toBe(result.constructorNonce);
    expect(result.action).toBe("committed");
    expect(result.lifecycle.legacyOpenCalled, body).toBe(false);
    expect(result.lifecycle.preparedRuntimeInvoked, body).toBe(true);
    expect(result.lifecycle.preparedRuntimeClosed, body).toBe(true);
    expect(result.lifecycle.requestFacetDisposed, body).toBe(true);
    expect(result.lifecycle.prepareInertCalls, body).toBe(1);
    expect(result.lifecycle.settled, body).toEqual({
      invocationRpc: true,
      fetch: true,
      ports: true,
    });
    expect(result.inFlight).toBe(0);
    expect(result.resident).toBe(0);
  }, 120_000);

  it("keeps placement owned when the public request facet cannot prove failed preparation cleanup", async () => {
    const response = await harness.fetch("/preparation-cleanup-failure");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly failureKind: string;
      readonly recoverable: boolean;
      readonly operationId: string;
      readonly processId: string;
      readonly controllerClaim: {
        readonly ownerId: string;
        readonly incarnationId: string;
        readonly epoch: number;
        readonly controlKey: string;
      };
      readonly identityState: string;
      readonly incarnationNonce: string;
      readonly state: string;
      readonly stopAcknowledged: boolean;
      readonly joined: {
        readonly invocationRpc: boolean;
        readonly fetch: boolean;
        readonly ports: boolean;
      };
      readonly held: boolean;
      readonly leaseCount: number;
      readonly inFlight: number;
      readonly recoveryCount: number;
      readonly lifecycle: {
        readonly disposeAttempts: number;
        readonly preparationFinalizerAttempts: number;
        readonly prepareInertCalls: number;
        readonly requestFacetDisposed: boolean;
      };
    };
    expect(result.failureKind).toBe("prepare-failed");
    expect(result.recoverable).toBe(true);
    expect(result.operationId).toBe("preparation-cleanup-failure-operation");
    expect(result.processId).toBe("preparation-cleanup-failure-process");
    expect(result.controllerClaim).toEqual({
      ownerId: "fixture-owner",
      incarnationId: "fixture-incarnation",
      epoch: 1,
      controlKey: "fixture-control-key-00000000000000000000000000000000",
    });
    expect(result.identityState).toBe("observed");
    expect(result.incarnationNonce).toBeTruthy();
    expect(result.state).toBe("cleanup-required");
    expect(result.stopAcknowledged).toBe(false);
    expect(result.joined).toEqual({ invocationRpc: true, fetch: false, ports: false });
    expect(result.held).toBe(true);
    expect(result.leaseCount).toBe(1);
    expect(result.inFlight).toBe(1);
    expect(result.recoveryCount).toBe(1);
    expect(result.lifecycle).toMatchObject({
      disposeAttempts: 1,
      preparationFinalizerAttempts: 1,
      prepareInertCalls: 1,
      requestFacetDisposed: false,
    });
  }, 120_000);

  it("retains confirmed request ownership after a committed RunStore reply is lost", async () => {
    const response = await harness.fetch("/invocation-reply-loss");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly invocationReplyDropped: boolean;
      readonly fixtureDroppedInvocationReply: boolean;
      readonly facetInvocationCalls: number;
      readonly invocationErrorKind: string;
      readonly preDispatchDuplicateRejected: boolean;
      readonly preDispatchParkBlocked: boolean;
      readonly preDispatchCleanupBlocked: boolean;
      readonly markerLeaseHeld: boolean;
      readonly markerInvocationAttempt?: number;
      readonly markerInvocationReply?: string;
      readonly admittedBeforeFinish: boolean;
      readonly duplicateDuringRuntimeRejected: boolean;
      readonly cleanupRetained: boolean;
      readonly actualRequestStatus?: string;
      readonly actualRequestFinish?: {
        readonly status: string;
        readonly result: { readonly id: string };
        readonly checkpoint: {
          readonly native: { readonly id: string };
          readonly filesystem: { readonly id: string };
        };
      };
      readonly facetLifecycle?: {
        readonly prepareCalls: number;
        readonly runtimeInvocationCount: number;
        readonly preparedRuntimeClosed: boolean;
        readonly disposeAttempts: number;
        readonly disposed: boolean;
        readonly runStoreActions: readonly string[];
        readonly runAttempts: number;
      };
      readonly record?: {
        readonly operationId: string;
        readonly processId: string;
        readonly controllerClaim: { readonly controlKey: string; readonly ownerId: string };
        readonly state: string;
        readonly publicationState: string;
        readonly publicationReceipt: {
          readonly operationId: string;
          readonly fromGeneration: number;
          readonly toGeneration: number;
          readonly preparedFacetNonce: string;
        };
        readonly invocationRequestId: string;
        readonly invocationAttempt: number;
        readonly invocationReply: string;
        readonly lastFailureCode: string;
        readonly stopAcknowledged: boolean;
        readonly joined: {
          readonly invocationRpc: boolean;
          readonly fetch: boolean;
          readonly ports: boolean;
        };
      };
      readonly firstLeaseHeld: boolean;
      readonly firstInFlight: number;
      readonly firstResident: number;
      readonly replacementNonceIsFresh: boolean;
      readonly reconciliationCalls: number;
      readonly reconstructionBlocked: boolean;
      readonly finalRecoveryCount: number;
      readonly finalLeaseStillHeld: boolean;
      readonly publisherCalls: number;
      readonly invocationCalls: number;
    };
    expect(result.invocationReplyDropped, body).toBe(true);
    expect(result.fixtureDroppedInvocationReply, body).toBe(true);
    expect(result.facetInvocationCalls, body).toBe(1);
    expect(result.invocationErrorKind, body).toBe("invocation-unsettled");
    expect(result.preDispatchDuplicateRejected, body).toBe(true);
    expect(result.preDispatchParkBlocked, body).toBe(true);
    expect(result.preDispatchCleanupBlocked, body).toBe(true);
    expect(result.markerLeaseHeld, body).toBe(true);
    expect(result.markerInvocationAttempt, body).toBe(1);
    expect(result.markerInvocationReply, body).toBe("unresolved");
    expect(result.admittedBeforeFinish, body).toBe(true);
    expect(result.duplicateDuringRuntimeRejected, body).toBe(true);
    expect(result.cleanupRetained).toBe(true);
    expect(result.actualRequestStatus, body).toBe("completed");
    expect(result.actualRequestFinish?.status).toBe("completed");
    expect(result.actualRequestFinish?.result.id).toBe("process-facet-proof-artifact");
    expect(result.actualRequestFinish?.checkpoint).toEqual({
      native: { id: "invocation-next-native", bytes: 1, sha256: "b".repeat(64) },
      filesystem: { id: "invocation-next-filesystem", bytes: 1, sha256: "c".repeat(64) },
    });
    expect(result.facetLifecycle).toMatchObject({
      prepareCalls: 1,
      runtimeInvocationCount: 1,
      preparedRuntimeClosed: true,
      disposeAttempts: 1,
      disposed: true,
      runAttempts: 1,
      runStoreActions: expect.arrayContaining([
        "read:unchanged",
        "request.admit:execute-once",
        "request.finish:committed",
      ]),
    });
    expect(result.record).toBeDefined();
    expect(result.record).toMatchObject({
      operationId: "invocation-reply-loss-operation",
      processId: "invocation-reply-loss-process",
      controllerClaim: {
        ownerId: "fixture-owner",
        controlKey: "fixture-control-key-00000000000000000000000000000000",
      },
      state: "cleanup-required",
      publicationState: "confirmed",
      invocationRequestId: "fixture-request-invocation-reply-loss-operation",
      invocationAttempt: 1,
      invocationReply: "unresolved",
      lastFailureCode: "INVOCATION_OUTCOME_UNKNOWN",
      stopAcknowledged: true,
      joined: { invocationRpc: true, fetch: true, ports: true },
    });
    expect(result.record!.publicationReceipt).toMatchObject({
      operationId: "invocation-reply-loss-operation",
      fromGeneration: 0,
      toGeneration: 1,
      preparedFacetNonce: expect.any(String),
    });
    expect(result.firstLeaseHeld).toBe(true);
    expect(result.firstInFlight).toBe(1);
    expect(result.firstResident).toBe(1);
    expect(result.replacementNonceIsFresh).toBe(true);
    expect(result.reconciliationCalls).toBe(1);
    expect(result.reconstructionBlocked).toBe(true);
    expect(result.finalRecoveryCount).toBe(1);
    expect(result.finalLeaseStillHeld).toBe(true);
    expect(result.publisherCalls).toBe(1);
    expect(result.invocationCalls).toBe(1);
  }, 120_000);

  it("admits a new invocation attempt after park and rejects stale durable receipts", async () => {
    const response = await harness.fetch("/invocation-readmission");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly firstAttempt: {
        readonly attempt?: number;
        readonly requestId?: string;
        readonly reply?: string;
        readonly settled: boolean;
      };
      readonly firstRequestIdentityProtected: boolean;
      readonly parkedInFlight: number;
      readonly parkedResident: number;
      readonly parkedPermitRetained?: boolean;
      readonly resumeValue: string;
      readonly readmittedInFlight: number;
      readonly readmittedResident: number;
      readonly unresolvedAttempt: {
        readonly attempt?: number;
        readonly requestId?: string;
        readonly reply?: string;
      };
      readonly duplicateRejected: boolean;
      readonly staleReceivedWriteRejected: boolean;
      readonly staleWriteLeftCurrentAttemptUnresolved: boolean;
      readonly leaseHeldWhileUnresolved: boolean;
      readonly secondAttempt: {
        readonly attempt?: number;
        readonly requestId?: string;
        readonly reply?: string;
        readonly settled: boolean;
      };
      readonly stableIdentity: boolean;
      readonly samePublication: boolean;
      readonly publisherCalls: number;
      readonly facetInvocations: readonly string[];
      readonly finalInFlight: number;
      readonly finalResident: number;
      readonly finalRecoveryCount: number;
      readonly firstSlotHeldBeforePark?: boolean;
    };
    expect(result.firstAttempt, body).toEqual({
      attempt: 1,
      requestId: "invocation-readmission-first",
      reply: "received",
      settled: true,
    });
    expect(result.firstRequestIdentityProtected, body).toBe(true);
    expect(result.firstSlotHeldBeforePark, body).toBe(true);
    expect(result.parkedInFlight, body).toBe(0);
    expect(result.parkedResident, body).toBe(1);
    expect(result.parkedPermitRetained, body).toBe(true);
    expect(result.resumeValue, body).toBe("readmitted");
    expect(result.readmittedInFlight, body).toBe(1);
    expect(result.readmittedResident, body).toBe(1);
    expect(result.unresolvedAttempt, body).toEqual({
      attempt: 2,
      requestId: "invocation-readmission-second",
      reply: "unresolved",
    });
    expect(result.duplicateRejected, body).toBe(true);
    expect(result.staleReceivedWriteRejected, body).toBe(true);
    expect(result.staleWriteLeftCurrentAttemptUnresolved, body).toBe(true);
    expect(result.leaseHeldWhileUnresolved, body).toBe(true);
    expect(result.secondAttempt, body).toEqual({
      attempt: 2,
      requestId: "invocation-readmission-second",
      reply: "received",
      settled: true,
    });
    expect(result.stableIdentity, body).toBe(true);
    expect(result.samePublication, body).toBe(true);
    expect(result.publisherCalls, body).toBe(1);
    expect(result.facetInvocations, body).toEqual([
      "invocation-readmission-first",
      "invocation-readmission-second",
    ]);
    expect(result.finalInFlight, body).toBe(0);
    expect(result.finalResident, body).toBe(0);
    expect(result.finalRecoveryCount, body).toBe(0);
  }, 120_000);

  it("keeps an honest provisional lease after the identity reply is lost and releases it on exact repair", async () => {
    const response = await harness.fetch("/identity-reply-loss");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly identityReplyLost: boolean;
      readonly remoteIdentityObserved: string;
      readonly provisional: {
        readonly identityState: string;
        readonly noncePresent: boolean;
        readonly state: string;
      };
      readonly heldAfterLostReply: { readonly inFlight: number; readonly resident: number };
      readonly stopAcknowledged: boolean;
      readonly joined: boolean;
      readonly disposed: boolean;
      readonly prepareCalls: number;
      readonly recoveredInFlight: number;
      readonly recoveredResident: number;
      readonly remainingRecoveryRecords: number;
    };
    expect(result.identityReplyLost).toBe(true);
    expect(result.remoteIdentityObserved).toBeTruthy();
    expect(result.provisional).toEqual({
      identityState: "unknown",
      noncePresent: false,
      state: "identity-unknown",
    });
    expect(result.heldAfterLostReply).toEqual({ inFlight: 1, resident: 1 });
    expect(result.stopAcknowledged).toBe(true);
    expect(result.joined).toBe(true);
    expect(result.disposed).toBe(true);
    expect(result.prepareCalls).toBe(0);
    expect(result.recoveredInFlight).toBe(0);
    expect(result.recoveredResident).toBe(0);
    expect(result.remainingRecoveryRecords).toBe(0);
  }, 120_000);

  it("generates a new constructor nonce when the same request-facet key is reconstructed", async () => {
    const response = await harness.fetch("/same-key-reconstruction");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly originalNonce: string;
      readonly replacementNonce: string;
    };
    expect(result.originalNonce).toBeTruthy();
    expect(result.replacementNonce).toBeTruthy();
    expect(result.replacementNonce).not.toBe(result.originalNonce);
  }, 120_000);

  it("routes 105 processes through four-process entrypoint requests and keyed facets", async () => {
    const response = await harness.fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 105 }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly result: {
        readonly processes: readonly {
          readonly processId: string;
          readonly requestContextId: string;
          readonly identity: {
            readonly loaderId: string;
            readonly facetKey: string;
            readonly incarnationNonce: string;
          } | null;
          readonly settlement?: {
            readonly value: {
              readonly snapshot: {
                readonly moduleNonce: string;
                readonly constructorNonce: string;
                readonly phases: readonly string[];
              };
            };
          };
          readonly status: string;
          readonly error?: {
            readonly facetFailureAt?: string;
            readonly facetFailureCode?: string;
            readonly causeCode?: string;
          };
        }[];
      };
    };

    expect(result.result.processes).toHaveLength(105);
    expect(
      result.result.processes.every((process) => process.status === "settled"),
      JSON.stringify(result.result.processes.slice(0, 4)),
    ).toBe(true);
    expect(
      result.result.processes.every((process) => process.settlement !== undefined),
      JSON.stringify(result.result.processes.slice(0, 4)),
    ).toBe(true);
    expect(result.result.processes.every((process) => process.identity !== null)).toBe(true);
    expect(new Set(result.result.processes.map((process) => process.identity!.loaderId)).size).toBe(
      105,
    );
    expect(
      result.result.processes.every((process) => process.identity!.loaderId.length > 128),
    ).toBe(true);
    expect(
      result.result.processes.every(
        (process) => process.identity!.facetKey === process.identity!.loaderId,
      ),
    ).toBe(true);
    expect(
      new Set(result.result.processes.map((process) => process.identity!.incarnationNonce)).size,
    ).toBe(105);
    expect(
      new Set(
        result.result.processes.map((process) => process.settlement!.value.snapshot.moduleNonce),
      ).size,
    ).toBe(105);
    expect(
      new Set(
        result.result.processes.map(
          (process) => process.settlement!.value.snapshot.constructorNonce,
        ),
      ).size,
    ).toBe(105);

    const perRequest = new Map<string, number>();
    for (const process of result.result.processes)
      perRequest.set(process.requestContextId, (perRequest.get(process.requestContextId) ?? 0) + 1);
    expect(perRequest.size).toBe(27);
    expect([...perRequest.values()].sort((left, right) => left - right)).toEqual([
      1,
      ...Array.from({ length: 26 }, () => 4),
    ]);

    for (const process of result.result.processes) {
      expect(process.settlement!.value.snapshot.phases).toEqual(["invoke"]);
      expect(process.settlement!.value.snapshot.constructorNonce).toBe(
        process.identity!.incarnationNonce,
      );
    }
    // Request group sizes prove routing only. They do not claim concurrent JavaScript execution.
  }, 120_000);

  it("rejects a duplicate runShard while the original owns its durable context", async () => {
    const response = await harness.fetch("/duplicate");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      duplicateRejected: true,
      result: { processes: [{ status: "settled" }] },
    });
  }, 120_000);

  it("releases an empty unplaceable writer for a later explicit request", async () => {
    const response = await harness.fetch("/unplaceable");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      firstResult: { processes: [{ status: "unplaceable", identity: null }] },
      retryResult: { processes: [{ status: "settled" }] },
    });
  }, 120_000);

  it("keeps published state recoverable under the current claim without replaying invocation", async () => {
    const start = await harness.fetch("/recover/start");
    const startBody = await start.text();
    expect(start.status, startBody).toBe(200);
    expect(startBody).not.toContain("private-prompt-sentinel");
    expect(JSON.parse(startBody), startBody).toMatchObject({
      result: { processes: [{ status: "recoverable", recoveryId: expect.any(String) }] },
    });

    const stale = await harness.fetch("/recover/stale");
    const staleBody = await stale.text();
    expect(stale.status, staleBody).toBe(200);
    expect(JSON.parse(staleBody)).toMatchObject({ staleRejected: true });

    const retry = await harness.fetch("/recover/retry");
    const retryBody = await retry.text();
    expect(retry.status, retryBody).toBe(200);
    const result = JSON.parse(retryBody) as {
      readonly result: { readonly processes: readonly { readonly status: string }[] };
      readonly invocationCalls: number;
    };
    expect(result.result.processes).toMatchObject([
      { status: "recoverable", error: { kind: "recovery-unresolved" } },
    ]);
    expect(result.invocationCalls).toBe(1);
  }, 120_000);

  it("reconstructs terminal activation cleanup without replaying or dropping repair ownership", async () => {
    const response = await harness.fetch("/terminal-recovery");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly failed: {
        readonly processes: readonly {
          readonly status: string;
          readonly error?: { readonly kind: string };
        }[];
      };
      readonly repaired: {
        readonly processes: readonly {
          readonly status: string;
          readonly error?: { readonly kind: string };
        }[];
      };
      readonly slotsHeld: number;
      readonly recovery: readonly {
        readonly state: string;
        readonly stopAcknowledged: boolean;
        readonly joined: {
          readonly invocationRpc: boolean;
          readonly fetch: boolean;
          readonly ports: boolean;
        };
        readonly terminalFailure?: { readonly code: string };
      }[];
    };
    expect(result.failed.processes).toMatchObject([
      { status: "recoverable", error: { kind: "activation-failed" } },
    ]);
    expect(result.repaired.processes).toMatchObject([
      { status: "recovered", error: { kind: "activation-failed" } },
    ]);
    expect(result.slotsHeld).toBe(0);
    expect(result.recovery).toMatchObject([
      {
        state: "activation-failed",
        stopAcknowledged: true,
        joined: { invocationRpc: true, fetch: true, ports: true },
        terminalFailure: { code: "RPC_FAILED" },
      },
    ]);
  }, 120_000);

  it("persists and reconciles a committed publication whose reply was lost without invoking or retiring it", async () => {
    const response = await harness.fetch("/publication-reply-loss");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly firstStatus: string;
      readonly firstKind: string;
      readonly secondStatus: string;
      readonly recoveryState: string;
      readonly publicationState: string;
      readonly receiptOperationId: string;
      readonly leaseStillHeld: boolean;
      readonly publisherCalls: number;
      readonly invocationCalls: number;
    };
    expect(result).toEqual({
      firstStatus: "recoverable",
      firstKind: "publication-unknown",
      secondStatus: "recoverable",
      recoveryState: "publication-confirmed",
      publicationState: "confirmed",
      receiptOperationId: "publication-reply-loss-operation-0",
      leaseStillHeld: true,
      publisherCalls: 1,
      invocationCalls: 0,
    });
  }, 120_000);

  it("transactionally fences delayed writer A mutations after writer B claims the shard", async () => {
    const response = await harness.fetch("/fence");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      duplicateRejected: true,
      staleReleaseRejected: true,
      oldWriterRejected: true,
      staleSaveRejected: true,
      staleRecoverySaveRejected: true,
      staleRecoveryRemoveRejected: true,
      stateUnchanged: true,
      recoveryUnchanged: true,
    });
  }, 120_000);

  it("reclaims a surviving store only after the same named execution DO is recreated", async () => {
    const response = await harness.fetch("/recover-shard");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      recoveryClaimed: true,
      stateSurvived: true,
      recoverySurvived: true,
      oldWriterRejected: true,
      liveDuplicateRejected: true,
      exactRecoveryRemoved: true,
    });
    const result = JSON.parse(body) as {
      readonly originalNonce: string;
      readonly replacementNonce: string;
    };
    expect(result.replacementNonce).not.toBe(result.originalNonce);
  }, 120_000);
});
