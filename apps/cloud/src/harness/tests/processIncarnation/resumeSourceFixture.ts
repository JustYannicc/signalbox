import type { HarnessProcessResumeOperationInput } from "../../HarnessProcessResume.ts";

const reference = (id: string) => ({ id, bytes: 4, sha256: "a".repeat(64) });
const control = {
  ownerId: "process-owner",
  incarnationId: "controller-one",
  epoch: 1,
  controlKey: "controller-one-secret-".repeat(2),
};
const publisher = {
  generation: 1,
  facetNonce: "facet-one",
  publisherKey: "facet-one-publisher-".repeat(2),
};
const request = { requestId: "turn-one", input: reference("input-one") };
const checkpoint = { native: reference("native-0"), filesystem: reference("filesystem-0") };
const process = { processId: "process", operationId: "process-one", nativeSessionId: "native" };
const placement = {
  owner: "execution-shard",
  executionOperationId: "execution-one",
  shardOwner: "execution-shard",
  shardIndex: 0,
  shardIncarnationNonce: "origin-nonce",
};
const identity = {
  shardOwner: placement.owner,
  loaderId: "loader-one",
  facetKey: "loader-one",
  incarnationNonce: publisher.facetNonce,
};
const journalAuthority = {
  controlKey: "journal-controller-".repeat(3),
  supervisor: { epoch: 1, claimId: "supervisor", supervisorKey: "supervisor-secret-".repeat(3) },
};
const release: HarnessProcessResumeOperationInput["transition"]["targetPreparedRelease"] = {
  artifact: {
    provider: "codex",
    releaseId: "target-release",
    artifactHash: "a".repeat(64),
    artifactRef: `sha256:${"a".repeat(64)}`,
    sourceIdentity: "source",
    fixtureIdentity: "fixture",
    createdAt: "2026-10-28T00:00:00.000Z",
  },
  plan: {
    release: { harness: "codex", version: "1.0.0", manifestSha256: "a".repeat(64), modules: {} },
    sourceIdentity: "source",
    computer: { sourceIdentity: "computer", manifestSha256: "b".repeat(64) },
    preparedModules: {},
  },
};

export const resumeOperation: HarnessProcessResumeOperationInput = {
  runId: "run-one",
  previousProcessId: process.processId,
  previousOperationId: process.operationId,
  previousStepId: request.requestId,
  runStore: {
    runId: "run-one",
    processId: process.processId,
    processOperationId: process.operationId,
    transitionOperationId: "resume-one",
    ...journalAuthority,
    currentPublisher: publisher,
    nextPublisherKey: "facet-two-publisher-".repeat(2),
    request,
    checkpoint,
  },
  transition: {
    operationId: "resume-one",
    control,
    publisher,
    nextControl: {
      ...control,
      epoch: 2,
      incarnationId: "controller-two",
      controlKey: "controller-two-secret-".repeat(2),
    },
    expectedFacetGeneration: 1,
    targetPreparedRelease: release,
  },
  productBootstrap: {
    provider: "codex",
    preparedReleaseId: release.artifact.releaseId,
    restoreMode: "cross-variant-fresh-boot",
  },
  facet: {
    processId: process.processId,
    codeId: "target-release",
    residentBytes: 1,
    mainModule: "main.js",
    modules: { "main.js": "export default {}" },
    entrypoint: "Process",
  },
};

export async function seedResumeSource(
  storage: DurableObjectStorage,
  fence: { owner: string; incarnation: number; nonce: string },
) {
  const ownedKey = "harness-owned-process/v1/run-one/process-one/turn-one";
  const terminalKey = "harness-process-terminal/v1/run-one/process-one/turn-one";
  const source = {
    version: 1,
    retained: false,
    runId: "run-one",
    process,
    request,
    control,
    publisher,
    runStorePublisher: publisher,
    parentCheckpoint: checkpoint,
    placement,
    identity,
    fence,
    terminalKey,
  };
  await storage.put({
    [ownedKey]: source,
    "harness-owned-process/v1/active/run-one": ownedKey,
    "harness-process-incarnation/v1/runs": ["run-one"],
    [terminalKey]: {
      version: 1,
      runId: "run-one",
      processId: process.processId,
      processOperationId: process.operationId,
      nativeSessionId: process.nativeSessionId,
      request,
      control,
      publisher,
      placement,
      identity,
      stopped: true,
      joined: { invocationRpc: true, fetch: true, ports: true },
    },
  });
  return ownedKey;
}
