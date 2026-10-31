import type {
  HarnessRunArtifact,
  HarnessRequestCheckpoint,
} from "../../../../src/harness/HarnessRunStore.ts";
import type { HarnessProcessPlacementIdentity } from "../../../../src/harness/HarnessProcessPlacement.ts";
import type { HarnessRunStoreObject } from "../../../../src/harness/HarnessRunStoreObject.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import type { Configuration } from "./configuration.ts";
import type { QualifierEnvironment } from "./environment.ts";
import type { ClaudeCTransport } from "./claudeCTransport.ts";
import type { ClaudeVariant, ClaudeStepPhase } from "./claudeScenario.ts";
import type { CombinedCodexModelPeer } from "./model/modelPeer.mjs";
import type { ModelRecoveryEvidence } from "./modelPhysicalRecovery.fixture.ts";
import type { QualifierStep, ModelIncarnation, WriterRelease } from "./proofRecords.ts";

export interface QualifierModelControl {
  readonly peer: CombinedCodexModelPeer;
  bind(nativeSessionId: string): void;
  begin(turn: number): ReturnType<CombinedCodexModelPeer["beginTurn"]>;
  complete(turn: number): Promise<void>;
  current(): ModelIncarnation;
  finish(): Promise<{
    complete: ReturnType<CombinedCodexModelPeer["assertComplete"]>;
    closed: Awaited<ReturnType<CombinedCodexModelPeer["closeAndJoin"]>>;
    snapshot: HarnessRunArtifact;
  }>;
}

/** Controllers receive the journal and lifecycle operations they use, not the concrete coordinator. */
export interface QualifierExecutionContext extends Pick<
  QualifierCapabilities,
  | "append"
  | "artifact"
  | "material"
  | "runnerEvents"
  | "recordActiveCheckpoint"
  | "readClaudeLoadedRelease"
> {
  readonly model: QualifierModelControl;
  readonly lifecycle: { currentCheckpoint(): HarnessRequestCheckpoint };
  readonly claude: { c(variant: ClaudeVariant, phase: ClaudeStepPhase): Promise<ClaudeCTransport> };
  config(): Promise<Configuration>;
  environment(): QualifierEnvironment;
  shardOwner(): string;
  shard(): ReturnType<QualifierEnvironment["PROCESS_EXECUTION_SHARDS"]["getByName"]>;
  assertLiveOwner(): Promise<void>;
  state<T>(key: string): Promise<T>;
  saveState(key: string, value: unknown): ReturnType<QualifierCapabilities["append"]>;
  knownTurn(turn: number): Promise<{
    turn: number;
    nativeSessionId: string;
    identity: HarnessProcessPlacementIdentity;
    committed: { status: string };
    checkpoint: unknown;
  }>;
  runStoreSnapshot(): ReturnType<HarnessRunStoreObject["execute"]>;
  commitModelRecord(record: Record<string, unknown>, artifact: HarnessRunArtifact): Promise<void>;
  writerReleaseFor(incarnation: string): Promise<WriterRelease>;
  physicalRecoveryFor(input: ModelIncarnation): Promise<ModelRecoveryEvidence | undefined>;
  modelTransition(): QualifierStep | undefined;
}
