import { readCreationRetirementEvidence } from "./modelCreationRetirement.fixture.ts";
import type {
  ProcessBoundary,
  ProcessFence,
  ProcessTerminalEvidence,
} from "../../../../src/harness/HarnessProcessResume.ts";
import { decoder, jsonBytes } from "./common.ts";

export async function readShardRecoveryEvidence(
  storage: DurableObjectStorage,
  readFence: () => Promise<ProcessFence>,
  runId: string,
) {
  const boundary = await storage.get<ProcessBoundary>(
    `harness-process-boundary/v1/${encodeURIComponent(runId)}`,
  );
  if (!boundary) return undefined;
  const currentFence = await readFence();
  const history = await storage.list<ProcessFence>({
    prefix: "harness-process-incarnation/v1/history/",
  });
  const creation = (await readCreationRetirementEvidence(storage)).find(
    (row) => row.record.claim.runId === runId,
  );
  return {
    boundary: {
      runId: boundary.runId,
      processId: boundary.process.processId,
      nativeSessionId: boundary.nativeSessionId,
      checkpoint: boundary.checkpoint,
      phase: boundary.phase,
      fence: boundary.fence,
      writer: {
        executionOperationId: boundary.placement.executionOperationId,
        shardIndex: boundary.placement.shardIndex,
        shardIncarnationNonce: boundary.fence.nonce,
        controllerClaim: boundary.control,
      },
      identity: boundary.prepared.identity,
      generation: boundary.requestPublisher.generation,
      requestPublisher: boundary.requestPublisher,
    },
    currentFence,
    history: [...history.values()],
    ...(creation ? { creation } : {}),
  };
}

export async function readShardExecutionEvidence(
  storage: DurableObjectStorage,
  readNonce: () => Promise<string>,
) {
  const terminal = await storage.list<ProcessTerminalEvidence>({
    prefix: "harness-process-terminal/v1/",
  });
  const completions = await storage.list({ prefix: "harness-process-completion/v1/" });
  const resumes = await storage.list({ prefix: "harness-process-resume/v1/" });
  const creation = await storage.list({
    prefix: "harness-process-creation-placement/v1/",
  });
  return {
    terminal: [...terminal].map(([key, value]) => ({ key, value })),
    // These storage records can contain byte arrays; the journal codec preserves them across RPC.
    completions: [...completions].map(
      ([key, value]) => [key, decoder.decode(jsonBytes(value))] as const,
    ),
    resumes: [...resumes].map(([key, value]) => [key, decoder.decode(jsonBytes(value))] as const),
    creation: [...creation].map(([key, value]) => [key, decoder.decode(jsonBytes(value))] as const),
    executionIncarnationNonce: await readNonce(),
  };
}
