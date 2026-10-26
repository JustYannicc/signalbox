import type {
  HarnessCProductBootstrapDescriptor,
  HarnessProcessExecutionJournal,
  HarnessProcessResumePreparedRelease,
} from "../processResume/contracts.ts";
import type { HarnessRequestPublisher } from "../HarnessRunStore.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../HarnessThreadSupervisor.ts";
import type { HarnessProcessFacetLocator } from "./contracts.ts";

export interface HarnessCProductCapabilityEnvironment {
  readonly HARNESS_C_PRODUCT_CAPABILITIES?: Readonly<Record<string, Fetcher>>;
}

export type HarnessProcessExecutionProductBootstrapInput =
  | {
      readonly productBootstrap: HarnessCProductBootstrapDescriptor;
      readonly targetPreparedRelease: HarnessProcessResumePreparedRelease;
    }
  | {
      readonly productBootstrap?: never;
      readonly targetPreparedRelease?: never;
    };

export interface HarnessProcessExecutionResumeFacetEnvironment {
  readonly HARNESS_RESUME_RUN_ID: string;
  readonly HARNESS_RESUME_CONTROL: HarnessThreadSupervisorControlClaim;
  readonly HARNESS_RESUME_PUBLISHER: HarnessThreadSupervisorPublisher;
  readonly HARNESS_RESUME_RUN_STORE: Fetcher;
  readonly HARNESS_RESUME_FILES_STORE: Fetcher;
  readonly HARNESS_RESUME_SUPERVISOR: Fetcher;
}

export type HarnessProcessExecutionProcessInput = {
  readonly processId: string;
  readonly codeId: string;
  readonly residentBytes: number;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly operationId: string;
  readonly priorFacetNonce: string;
  readonly expectedFacetGeneration: number;
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string | { readonly js: string }>>;
  readonly entrypoint: string;
  readonly journal?: HarnessProcessExecutionJournal;
  /** Publisher capability for the fresh RunStore facet, bound to this lease's nonce at open. */
  readonly runStorePublisher?: Pick<HarnessRequestPublisher, "generation" | "publisherKey">;
  /** Bindings come from the harness owner. Fixture-only observers stay in the fixture. */
  readonly facetEnv?: Readonly<Record<string, unknown>>;
  /** Resume authorities are separate from generic process environment supplied by callers. */
  readonly resumeFacetEnv?: HarnessProcessExecutionResumeFacetEnvironment;
} & HarnessProcessExecutionProductBootstrapInput;

export interface HarnessProcessExecutionEnvironment extends HarnessCProductCapabilityEnvironment {
  readonly LOADER: WorkerLoader;
  readonly PLACEMENT_STORES: DurableObjectNamespace;
  readonly HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace;
  readonly RESIDENT_BYTE_LIMIT: string;
}

const reservedFacetEnvironmentKeys = [
  "HARNESS_C_PRODUCT_BOOTSTRAP",
  "HARNESS_C_TARGET_PREPARED_RELEASE",
  "HARNESS_C_PRODUCT_CAPABILITIES",
  "HARNESS_PROCESS_ID",
  "HARNESS_PROCESS_SHARD_OWNER",
  "HARNESS_PROCESS_LOADER_ID",
  "HARNESS_PROCESS_FACET_KEY",
  "HARNESS_REQUEST_PUBLISHER",
  "HARNESS_RESUME_RUN_ID",
  "HARNESS_RESUME_CONTROL",
  "HARNESS_RESUME_PUBLISHER",
  "HARNESS_RESUME_RUN_STORE",
  "HARNESS_RESUME_FILES_STORE",
  "HARNESS_RESUME_SUPERVISOR",
] as const;

export function createHarnessProcessFacetEnvironment(
  process: HarnessProcessExecutionProcessInput,
  environment: HarnessCProductCapabilityEnvironment,
  identity: HarnessProcessFacetLocator,
): Readonly<Record<string, unknown>> {
  const { productBootstrap, targetPreparedRelease } = process;
  if ((productBootstrap === undefined) !== (targetPreparedRelease === undefined))
    throw new TypeError(
      "A product bootstrap descriptor and its expected release must travel together.",
    );
  if (
    productBootstrap !== undefined &&
    (productBootstrap.provider !== targetPreparedRelease.artifact.provider ||
      productBootstrap.preparedReleaseId !== targetPreparedRelease.artifact.releaseId)
  )
    throw new TypeError("The product bootstrap must identify its expected prepared release.");

  const facetEnv = { ...process.facetEnv };
  for (const key of reservedFacetEnvironmentKeys) delete facetEnv[key];

  return {
    ...facetEnv,
    ...(productBootstrap === undefined
      ? {}
      : {
          HARNESS_C_PRODUCT_BOOTSTRAP: productBootstrap,
          HARNESS_C_TARGET_PREPARED_RELEASE: targetPreparedRelease,
        }),
    ...(environment.HARNESS_C_PRODUCT_CAPABILITIES === undefined
      ? {}
      : { HARNESS_C_PRODUCT_CAPABILITIES: environment.HARNESS_C_PRODUCT_CAPABILITIES }),
    HARNESS_PROCESS_ID: process.processId,
    HARNESS_PROCESS_SHARD_OWNER: identity.shardOwner,
    HARNESS_PROCESS_LOADER_ID: identity.loaderId,
    HARNESS_PROCESS_FACET_KEY: identity.facetKey,
    ...(process.runStorePublisher === undefined
      ? {}
      : {
          HARNESS_REQUEST_PUBLISHER: {
            generation: process.runStorePublisher.generation,
            publisherKey: process.runStorePublisher.publisherKey,
          } satisfies Pick<HarnessRequestPublisher, "generation" | "publisherKey">,
        }),
    ...(process.resumeFacetEnv === undefined
      ? {}
      : {
          HARNESS_RESUME_RUN_ID: process.resumeFacetEnv.HARNESS_RESUME_RUN_ID,
          HARNESS_RESUME_CONTROL: process.resumeFacetEnv.HARNESS_RESUME_CONTROL,
          HARNESS_RESUME_PUBLISHER: process.resumeFacetEnv.HARNESS_RESUME_PUBLISHER,
          HARNESS_RESUME_RUN_STORE: process.resumeFacetEnv.HARNESS_RESUME_RUN_STORE,
          HARNESS_RESUME_FILES_STORE: process.resumeFacetEnv.HARNESS_RESUME_FILES_STORE,
          HARNESS_RESUME_SUPERVISOR: process.resumeFacetEnv.HARNESS_RESUME_SUPERVISOR,
        }),
  };
}
