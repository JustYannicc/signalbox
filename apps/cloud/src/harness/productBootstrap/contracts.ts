import type { ThreadId } from "@t3tools/contracts";
import type { HarnessReleaseArtifact } from "../../harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessRunArtifact } from "../HarnessRunStore.ts";
import type { ExecutorTarget, ProgramSeed, ResolvedConnections } from "../HarnessSessionHost.ts";
import type {
  HarnessCProductBootstrapDescriptor,
  HarnessCProductProvider,
  HarnessProcessResumePreparedRelease,
} from "../HarnessProcessResume.ts";
import type { MachineProgramInventory } from "../../computer/MachineProgramInventory.ts";
import type { CommandProgramCodes } from "../../computer/CommandGateway.ts";

export interface HarnessCProductBootstrapEnvironment {
  readonly HARNESS_C_PRODUCT_BOOTSTRAP?: HarnessCProductBootstrapDescriptor;
  readonly HARNESS_C_TARGET_PREPARED_RELEASE?: HarnessProcessResumePreparedRelease;
}

export interface HarnessCProductReleaseService {
  getArtifact(
    provider: HarnessCProductProvider,
    releaseId: string,
  ): Promise<HarnessReleaseArtifact | null>;
  loaderConfig(provider: HarnessCProductProvider): Promise<{
    readonly trustedComputer: {
      readonly sourceIdentity: string;
      readonly manifestSha256: string;
    };
    readonly maxPreparedModuleBytes: number;
  }>;
  readArtifact(artifactRef: string, path: string): Promise<Uint8Array>;
}

export interface HarnessCProductNativeCheckpointService {
  read(reference: HarnessRunArtifact): Promise<Uint8Array>;
}

export interface HarnessCProductAccessService<G> {
  resolveInitialAccess(input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
    readonly nativeSessionId: string;
  }): Promise<{ readonly grant: G; readonly connections: ResolvedConnections }>;
  resolveTurnAccess(input: {
    readonly threadId: ThreadId;
    readonly runId: string;
    readonly requestId: string;
  }): Promise<{ readonly grant: G; readonly connections: ResolvedConnections }>;
}

export interface HarnessCProductProgramCatalog {
  readonly sourceIdentity: string;
  readonly codes: CommandProgramCodes;
  readonly files: ProgramSeed["files"];
}

export interface HarnessCProductProgramService {
  catalog(provider: HarnessCProductProvider): Promise<HarnessCProductProgramCatalog>;
  read(path: string): Promise<Uint8Array>;
}

export interface HarnessCProductMachineService {
  inventory(provider: HarnessCProductProvider): Promise<MachineProgramInventory>;
}

export interface HarnessCProductExecutorRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly body: Uint8Array | null;
}

export interface HarnessCProductExecutorResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly body: Uint8Array;
}

export interface HarnessCProductExecutorForwardInput<G> {
  readonly target: ExecutorTarget;
  readonly grant: G;
  readonly request: HarnessCProductExecutorRequest;
  /** AbortSignal cannot cross Workers RPC; closing this stream revokes the request. */
  readonly cancellation: ReadableStream<Uint8Array>;
}

export interface HarnessCProductExecutorService<G> {
  forward(input: HarnessCProductExecutorForwardInput<G>): Promise<HarnessCProductExecutorResponse>;
}

export interface HarnessCProductModelService {
  fetch(request: Request): Promise<Response>;
}
