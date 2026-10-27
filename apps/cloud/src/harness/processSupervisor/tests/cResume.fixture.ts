import * as Effect from "effect/Effect";
import {
  createHarnessProcessResume,
  type HarnessProcessResumeDriver,
  type HarnessProcessResumeInput,
  type HarnessProcessResumePreparedFacet,
  type HarnessProcessResumePreparedRelease,
  type HarnessProcessResumePublicationResult,
  type HarnessProcessResumeResult,
} from "../../HarnessProcessResume.ts";
import type {
  HarnessProcessSupervisorCheckpoint,
  HarnessProcessSupervisorRestart,
} from "../../HarnessProcessSupervisor.ts";

const release: HarnessProcessResumePreparedRelease = {
  artifact: {
    provider: "claude-code",
    releaseId: "fixture-release",
    artifactHash: "a".repeat(64),
    artifactRef: `sha256:${"a".repeat(64)}`,
    sourceIdentity: "fixture-source",
    fixtureIdentity: "fixture",
    createdAt: "2026-10-27T00:00:00.000Z",
  },
  plan: {
    release: {
      harness: "claude-code",
      version: "fixture",
      manifestSha256: "a".repeat(64),
      modules: { "cli/main": { bytes: 1, sha256: "b".repeat(64) } },
    },
    sourceIdentity: "fixture-source",
    computer: { sourceIdentity: "fixture-computer", manifestSha256: "c".repeat(64) },
    preparedModules: {
      "cli/main": {
        component: "cli",
        name: "main",
        path: "cli/main.js",
        bytes: 1,
        sha256: "b".repeat(64),
        type: "js",
      },
    },
  },
};

export const resumeInput = (
  intent: HarnessProcessSupervisorRestart,
): HarnessProcessResumeInput => ({
  operationId: intent.operationId,
  control: {
    ownerId: "caller-owner",
    incarnationId: "caller-control",
    epoch: intent.attempt,
    controlKey: "a".repeat(32),
  },
  nextControl: {
    ownerId: "caller-owner",
    incarnationId: "caller-control",
    epoch: intent.attempt + 1,
    controlKey: "b".repeat(32),
  },
  publisher: { ...intent.incarnation, publisherKey: "c".repeat(32) },
  expectedFacetGeneration: intent.incarnation.generation,
  targetPreparedRelease: release,
});

export const resumeResult = (
  input: HarnessProcessResumeInput,
  checkpoint: HarnessProcessSupervisorCheckpoint,
): HarnessProcessResumeResult<
  HarnessProcessResumePreparedFacet,
  HarnessProcessResumePublicationResult
> => {
  const generation = input.expectedFacetGeneration + 1;
  const facetNonce = `facet-${generation}`;
  const preparedFacet = {
    identity: {
      shardOwner: "fixture-shard",
      loaderId: `loader-${generation}`,
      facetKey: `key-${generation}`,
      incarnationNonce: facetNonce,
      preparedRelease: input.targetPreparedRelease,
    },
  };
  const reference = {
    checkpointId: checkpoint.checkpointId,
    manifestSha256: checkpoint.manifestSha256,
  };
  const receipt = {
    operationId: input.operationId,
    fromGeneration: input.expectedFacetGeneration,
    toGeneration: generation,
    priorFacetNonce: input.publisher.facetNonce,
    preparedFacetNonce: facetNonce,
    checkpoint: reference,
    status: "confirmed" as const,
  };
  return {
    preparedFacet,
    publication: {
      status: "published",
      control: input.nextControl,
      receipt,
      files: {
        action: "confirmed",
        checkpoint: reference,
        parentCheckpointId: null,
        activeStepId: null,
        admissionResolution: null,
        publication: receipt,
        files: [],
      },
      supervisor: {
        action: "published",
        currentPublisher: { generation, facetNonce, publisherKey: "d".repeat(32) },
        preparedPublisher: { generation, facetNonce, publisherKey: "d".repeat(32) },
        snapshot: {
          runId: "fixture-run",
          ownerId: input.nextControl.ownerId,
          controlIncarnationId: input.nextControl.incarnationId,
          controlEpoch: input.nextControl.epoch,
          nativeSessionId: checkpoint.nativeSessionId,
          checkpoint: reference,
          generation,
          facetNonce,
          lifecycle: "published",
          admittedStepId: null,
          pendingControlSync: null,
          preparedFacet: {
            operationId: input.operationId,
            generation,
            facetNonce,
            checkpoint: reference,
          },
          lastPublication: receipt,
          lastPublicationOperationId: input.operationId,
          stopAcknowledgementId: "external-stop-receipt",
          settlement: {
            outcome: "stopped",
            invocationRpcJoined: true,
            fetchJoined: true,
            callbackPortsJoined: true,
          },
          lastFailure: null,
          reconciliationEvidenceId: null,
          reconciliationExpectedGeneration: null,
          reconciliationAdmissionResolution: null,
          reconciliationOutcome: null,
          reconciliationCheckpoint: null,
          reconciliationInvocationSettlement: null,
          reconciliationPreparedFacetCleanup: null,
        },
      },
    },
  };
};

type Driver = HarnessProcessResumeDriver<
  HarnessProcessResumeInput,
  HarnessProcessSupervisorCheckpoint,
  HarnessProcessResumePreparedFacet,
  HarnessProcessResumePublicationResult,
  string
>;

/** The actual public C algorithm runs here. Only its external driver ports are controlled. */
export const realResume = (
  checkpoint: HarnessProcessSupervisorCheckpoint,
  calls: string[],
  overrides: Partial<Driver> = {},
) => {
  const record = <A>(name: string, value: A) =>
    Effect.sync(() => {
      calls.push(name);
      return value;
    });
  const driver: Driver = {
    beginDrain: (input) => record("fence", input),
    awaitDrain: () => record("drain", { _tag: "committed", checkpoint }),
    isCurrentControl: () => record("authority", true),
    readNativeSessionId: () => record("native-session", checkpoint.nativeSessionId),
    verifyCheckpoint: () => record("checkpoint", undefined),
    prepareInert: ({ drain }) => record("prepare", resumeResult(drain, checkpoint).preparedFacet),
    verifyPrepared: () => record("verify", undefined),
    persistPrepared: () => record("persist-prepared", undefined),
    publishFreshFacet: ({ drain }) =>
      record("publish", resumeResult(drain, checkpoint).publication),
    activate: () => record("activate", undefined),
    cleanupPrepared: () =>
      record("cleanup", { _tag: "complete", evidence: "external-cleanup-receipt" }),
    recordFailure: () => record("recovery", "recorded"),
    ...overrides,
  };
  return createHarnessProcessResume(driver);
};
