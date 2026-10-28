import { describe, expect, it } from "vite-plus/test";
import {
  recoverModelPhysicalIncarnation,
  verifyModelPhysicalRecovery,
  assertLiveModelRecoveryCandidate,
  type ModelSocketDrain,
} from "./modelPhysicalRecovery.fixture.ts";

import {
  parseEvictedRecoveryReceipt,
  parseRecoveryRecord,
} from "../../HarnessProcessPlacementEvidence.ts";

function evidence() {
  const control = { ownerId: "owner", incarnationId: "controller", epoch: 2, controlKey: "key" };
  const sourceFence = { owner: "placement", incarnation: 2, nonce: "parent-2" };
  const currentFence = { owner: "placement", incarnation: 3, nonce: "parent-3" };
  const sourceWriter = {
    executionOperationId: "create",
    shardIndex: 0,
    shardIncarnationNonce: sourceFence.nonce,
    controllerClaim: control,
  };
  const identity = {
    shardOwner: "placement",
    loaderId: "previous-loader",
    facetKey: "previous-loader",
    incarnationNonce: "previous-facet",
  };
  const checkpoint = {
    native: { id: "turn-1", bytes: 10, sha256: "native-digest" },
    filesystem: { id: "turn-1", bytes: 20, sha256: "files-digest" },
  };
  const expected = {
    owner: "placement",
    controllerClaim: control,
    runId: "run",
    processId: "codex",
    nativeSessionId: "native-session",
    checkpoint,
    from: { incarnation: identity.incarnationNonce, loaderId: identity.loaderId },
    to: { incarnation: "recovered-facet", loaderId: "recovered-loader" },
  };
  return {
    expected,
    evidence: {
      boundary: {
        runId: expected.runId,
        processId: expected.processId,
        nativeSessionId: expected.nativeSessionId,
        checkpoint,
        phase: "restoring",
        fence: sourceFence,
        writer: sourceWriter,
        identity,
        generation: 2,
      },
      currentFence,
      history: [sourceFence, currentFence],
      candidate: {
        ...parseRecoveryRecord(
          {
            version: 1 as const,
            shardOwner: "placement",
            controllerClaim: control,
            operationId: "eviction-restore-3-parent-3",
            processId: expected.processId,
            nativeSessionId: expected.nativeSessionId,
            checkpointId: "turn-1",
            manifestRevision: "files-digest",
            priorFacetNonce: identity.incarnationNonce,
            expectedFacetGeneration: 2,
            programCodeId: "code",
            loaderId: expected.to.loaderId,
            facetKey: expected.to.loaderId,
            incarnationNonce: expected.to.incarnation,
            identityState: "observed" as const,
            state: "preparing" as const,
            lease: {
              token: "new-token",
              loaderId: expected.to.loaderId,
              codeId: "new-code",
              residentBytes: 100,
            },
            stopAcknowledged: false,
            joined: { invocationRpc: false, fetch: false, ports: false },
          },
          "placement",
        ),
      },
      retirement: {
        ...parseEvictedRecoveryReceipt({
          version: 1 as const,
          owner: "placement",
          sourceFence,
          currentFence,
          sourceWriter,
          currentWriter: { ...sourceWriter, shardIncarnationNonce: currentFence.nonce },
          processId: expected.processId,
          identity,
          lease: {
            token: "old-token",
            loaderId: identity.loaderId,
            codeId: "old-code",
            residentBytes: 100,
          },
          state: "completed",
        }),
        currentWriter: { ...sourceWriter, shardIncarnationNonce: currentFence.nonce },
      },
    },
  };
}

describe("physical model recovery evidence", () => {
  it("accepts the producer's preparing record with invocation fields still absent", () => {
    const input = evidence();
    expect(() => assertLiveModelRecoveryCandidate(input.evidence.candidate)).not.toThrow();
    expect(() =>
      assertLiveModelRecoveryCandidate({ ...input.evidence.candidate, stopAcknowledged: true }),
    ).toThrow();
    expect(() =>
      assertLiveModelRecoveryCandidate({
        ...input.evidence.candidate,
        invocationMayHaveStarted: true,
      }),
    ).toThrow();
    expect(() =>
      assertLiveModelRecoveryCandidate({
        ...input.evidence.candidate,
        publicationState: "unknown",
      }),
    ).toThrow();
    expect(() =>
      assertLiveModelRecoveryCandidate({
        ...input.evidence.candidate,
        joined: { invocationRpc: false, fetch: true, ports: false },
      }),
    ).toThrow();
  });
  it("binds the same logical session and checkpoint to the completed physical retirement", () => {
    const input = evidence();
    const proof = verifyModelPhysicalRecovery(input.expected, input.evidence);
    expect(proof.nativeSessionId).toBe(input.expected.nativeSessionId);
    expect(proof.checkpoint).toEqual(input.expected.checkpoint);
    expect(proof.from).toEqual(input.expected.from);
    expect(proof.to).toEqual(input.expected.to);
    expect(proof.retirement.state).toBe("completed");
  });

  it.each([
    [
      "native session",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.candidate.nativeSessionId = "another-session";
      },
    ],
    [
      "checkpoint",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.candidate.checkpointId = "another-turn";
      },
    ],
    [
      "manifest",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.candidate.manifestRevision = "another-manifest";
      },
    ],
    [
      "prior facet",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.candidate.priorFacetNonce = "another-parent";
      },
    ],
    [
      "new facet",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.candidate.incarnationNonce = "another-facet";
      },
    ],
    [
      "generation",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.candidate.expectedFacetGeneration = input.evidence.boundary.generation + 1;
      },
    ],
    [
      "incomplete retirement",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.retirement.state = "authorized";
      },
    ],
    [
      "source fence",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.retirement.sourceFence = {
          ...input.evidence.retirement.sourceFence,
          nonce: "forged",
        };
      },
    ],
    [
      "receiver fence",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.retirement.currentFence = {
          ...input.evidence.retirement.currentFence,
          nonce: "forged",
        };
      },
    ],
    [
      "source writer",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.retirement.sourceWriter = {
          ...input.evidence.retirement.sourceWriter,
          executionOperationId: "forged",
        };
      },
    ],
    [
      "retired identity",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.retirement.identity = {
          ...input.evidence.retirement.identity,
          incarnationNonce: "forged",
        };
      },
    ],
    [
      "logical controller",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.retirement.currentWriter.controllerClaim = {
          ...input.evidence.retirement.currentWriter.controllerClaim,
          epoch: 3,
        };
      },
    ],
    [
      "missing history",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.history = [input.evidence.currentFence];
      },
    ],
    [
      "non-recovery operation",
      (input: ReturnType<typeof evidence>) => {
        input.evidence.candidate.operationId = "logical-replacement";
      },
    ],
  ])("rejects changed %s", (_description, mutate) => {
    const input = evidence();
    mutate(input);
    expect(() => verifyModelPhysicalRecovery(input.expected, input.evidence)).toThrow();
  });
});

it("waits for exact retirement verification and old socket joins before returning a rebind", async () => {
  const input = evidence();
  const verified = Promise.withResolvers<void>();
  const draining = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<ModelSocketDrain>();
  const physicalOrdinals = new Map([[input.expected.from.incarnation, 3]]);
  const logicalIncarnations = new Map([[input.expected.from.incarnation, 1]]);
  let drainCalls = 0;
  let returned = false;
  const transition = recoverModelPhysicalIncarnation(
    {
      fromIncarnation: input.expected.from.incarnation,
      toIncarnation: input.expected.to.incarnation,
      nativeSessionId: input.expected.nativeSessionId,
      checkpoint: input.expected.checkpoint,
      receipt: input.evidence,
    },
    {
      nativeSessionId: input.expected.nativeSessionId,
      currentIncarnation: input.expected.from.incarnation,
      preparedIncarnation: input.expected.from.incarnation,
      activeTurnIncarnation: input.expected.from.incarnation,
      logicalReplacementCount: 1,
      physicalOrdinals,
      logicalIncarnations,
    },
    async () => {
      await verified.promise;
      return {
        durable: true,
        retirementCompleted: true,
        nativeSessionId: input.expected.nativeSessionId,
        checkpoint: input.expected.checkpoint,
      };
    },
    async (incarnation) => {
      expect(incarnation).toBe(input.expected.from.incarnation);
      drainCalls++;
      draining.resolve();
      return drained.promise;
    },
  ).then((result) => {
    returned = true;
    return result;
  });
  expect(drainCalls).toBe(0);
  verified.resolve();
  await draining.promise;
  expect(returned).toBe(false);
  drained.resolve({
    incarnation: input.expected.from.incarnation,
    socketCount: 2,
    alreadyClosed: 1,
    closedAndJoined: true,
  });
  const result = await transition;
  expect(result.logicalIncarnation).toBe(1);
  expect(result.toIncarnation).toBe(input.expected.to.incarnation);
  expect(result.modelSocketDrain.socketCount).toBe(2);
  expect(physicalOrdinals.has(input.expected.to.incarnation)).toBe(false);
  expect(logicalIncarnations.get(input.expected.from.incarnation)).toBe(1);
});
