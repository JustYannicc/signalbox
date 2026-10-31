import type { HarnessProcessExecutionShardObject } from "../../../../src/harness/HarnessProcessExecutionShardObject.ts";
import type { HarnessRunStoreObject } from "../../../../src/harness/HarnessRunStoreObject.ts";
import type { HarnessProcessPlacementStoreObject } from "../../../../src/harness/HarnessProcessPlacementStoreObject.ts";
import type { HarnessRunArtifact } from "../../../../src/harness/HarnessRunStore.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import type { Configuration } from "./configuration.ts";
import type { ClaudeStep } from "./claudeScenario.ts";
import type { createClaudeFixtureServices } from "./claudeFixtureServices.ts";
import type {
  placementReleaseEvidence,
  ObservedPlacementStore,
} from "./placementReleaseObserver.fixture.ts";
import type { readShardRecoveryEvidence, readShardExecutionEvidence } from "./shardEvidence.ts";
import type { WriterRelease } from "./proofRecords.ts";

type JournalReceipt = Awaited<ReturnType<QualifierCapabilities["append"]>>;

/** Namespace clients describe the RPC contract without depending on their object constructors. */
export type QualifierProofPort = Rpc.DurableObjectBranded &
  Pick<QualifierCapabilities, "append" | "readArtifactChunk"> & {
    config(): Promise<Configuration>;
    claudeStepForLoader(): Promise<ClaudeStep>;
    modelConstructionPhase(): Promise<{ route: string; logicalIncarnation: number }>;
    commandPhase(): Promise<string>;
    recordWriterRelease(input: Omit<WriterRelease, "sequence">): Promise<WriterRelease>;
    tailRecords(
      raw: unknown,
      ingress?: "outer-platform" | "dynamic-platform",
    ): Promise<JournalReceipt>;
    guardDiagnostic(): Promise<{
      officialNativeStarted: boolean;
      records: { key: string; payload: HarnessRunArtifact; value: string }[];
    }>;
    guardDrain(invocationIds: string[]): Promise<{
      officialNativeStarted: boolean;
      source: Configuration["sourcePins"];
      records: { key: string; ingress: string; raw: string; payload: HarnessRunArtifact }[];
    }>;
    fetch(request: Request): Promise<Response>;
  };

export type QualifierRunStorePort = Rpc.DurableObjectBranded &
  Pick<HarnessRunStoreObject, keyof HarnessRunStoreObject> & {
    waitForFinish(requestId: string): ReturnType<HarnessRunStoreObject["execute"]>;
  };

export type QualifierPlacementStorePort = Rpc.DurableObjectBranded &
  Pick<ObservedPlacementStore, keyof ObservedPlacementStore> & {
    ownership(owner: string): Promise<{
      writer: NonNullable<
        Awaited<ReturnType<HarnessProcessPlacementStoreObject["readWriter"]>>
      > | null;
      leases: number;
      records: Awaited<ReturnType<HarnessProcessPlacementStoreObject["listRecovery"]>>;
    }>;
  };

export type QualifierShardPort = Rpc.DurableObjectBranded &
  Pick<HarnessProcessExecutionShardObject, keyof HarnessProcessExecutionShardObject> & {
    modelRecoveryEvidence(runId: string): ReturnType<typeof readShardRecoveryEvidence>;
    placementReleaseEvidence(): ReturnType<typeof placementReleaseEvidence>;
    evidence(): ReturnType<typeof readShardExecutionEvidence>;
    observerCalibration(): Promise<{
      identity: { facetNonce: string };
      observed: { incarnation: string; nativeStarted: false };
      executionEnvironment: {
        constructorPath: string;
        assetsRoundTrip: boolean;
        configSha256: string;
        nativeStarted: boolean;
      };
      loaderId: string;
      nativeStarted: boolean;
    }>;
  };

type FixtureServices = ReturnType<typeof createClaudeFixtureServices>;
export type QualifierClaudeFixturesPort = Rpc.DurableObjectBranded & {
  resolveFreshAccess: NonNullable<FixtureServices["resolveFreshAccess"]>;
  resolveInitialAccess: FixtureServices["resolveInitialAccess"];
  resolveTurnAccess: FixtureServices["resolveTurnAccess"];
  forward: FixtureServices["forward"];
  publishContinuation: FixtureServices["publishContinuation"];
};
