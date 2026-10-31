import * as Schema from "effect/Schema";
import { HARNESS_C_PRODUCT_CAPABILITY_KEYS as Keys } from "../../../src/harness/HarnessCProductCapabilities.ts";
import { PreparedRelease } from "./preparedRelease.schema.ts";
import {
  hasQualifierMethods,
  QualifierHash,
  QualifierRunId,
  QualifierWorkerName,
} from "./environmentContract.ts";

const NonEmpty = Schema.String.check(Schema.isPattern(/\S/u));
const releaseMethods = [
  "getArtifact",
  "loaderConfig",
  "readArtifact",
  "readArtifactChunk",
  "hostConfiguration",
  "append",
  "read",
  "artifact",
  "recordRunnerEvent",
  "setCheckpointParent",
  "stageCheckpoint",
  "activeCheckpointId",
  "verifyFiles",
  "verifyArtifact",
  "recordRaw",
] as const;
const resumePhase = Schema.makeFilter(
  (environment: {
    readonly HARNESS_RESUME_CREATION?: true;
    readonly HARNESS_RESUME_PUBLISHER?: unknown;
  }) =>
    environment.HARNESS_RESUME_CREATION === true ||
    environment.HARNESS_RESUME_PUBLISHER !== undefined,
);
export const QualifierClaudeInputs = Schema.Struct({
  RUN_ID: QualifierRunId,
  CONFIG_SHA256: QualifierHash,
  QUALIFIER_CLAUDE_VARIANT: Schema.Literals(["baseline", "hooks"]),
});
export const QualifierCodexInputs = Schema.Struct({
  QUALIFIER_CONFIGURATION: Schema.Struct({
    runId: QualifierRunId,
    workerName: QualifierWorkerName,
  }),
});

// Planned resources stay descriptors; only runtime decoding accepts live RPC methods.
export function qualifierFacetConfigurationSchemas<
  Service extends Schema.Top,
  Assets extends Schema.Top,
>(ports: { service: (methods: readonly string[]) => Service; assets: Assets }) {
  const capabilities = {
    [Keys.release]: ports.service([...releaseMethods, "prepareModelIncarnation", "seedCheckpoint"]),
    [Keys.nativeCheckpoint]: ports.service(["read"]),
    [Keys.access]: ports.service([
      "resolveFreshAccess",
      "resolveInitialAccess",
      "resolveTurnAccess",
    ]),
    [Keys.programs]: ports.service(["catalog", "read"]),
    [Keys.machine]: ports.service(["inventory"]),
    [Keys.model]: ports.service(["fetch"]),
    [Keys.executor]: ports.service(["forward"]),
    qualifierCommands: ports.service(["run"]),
  };
  const shared = {
    HARNESS_PROCESS_ID: NonEmpty,
    HARNESS_PROCESS_SHARD_OWNER: NonEmpty,
    HARNESS_PROCESS_LOADER_ID: NonEmpty,
    HARNESS_PROCESS_FACET_KEY: NonEmpty,
    HARNESS_C_PRODUCT_BOOTSTRAP: Schema.Struct({
      provider: Schema.Literals(["codex", "claude-code"]),
      preparedReleaseId: NonEmpty,
      restoreMode: Schema.Literal("same-variant-serialized-checkpoint"),
    }),
    HARNESS_C_TARGET_PREPARED_RELEASE: PreparedRelease,
    HARNESS_RESUME_RUN_ID: NonEmpty,
    HARNESS_RESUME_CONTROL: Schema.Struct({
      ownerId: NonEmpty,
      incarnationId: NonEmpty,
      epoch: Schema.Int.check(Schema.isGreaterThan(0)),
      controlKey: NonEmpty,
    }),
    HARNESS_RESUME_CREATION: Schema.optionalKey(Schema.Literal(true)),
    HARNESS_RESUME_PUBLISHER: Schema.optionalKey(
      Schema.Struct({
        generation: Schema.Int.check(Schema.isGreaterThan(0)),
        facetNonce: NonEmpty,
        publisherKey: NonEmpty,
      }),
    ),
    HARNESS_RESUME_RUN_STORE: ports.service(["execute"]),
    HARNESS_RESUME_FILES_STORE: ports.service(["execute"]),
    HARNESS_RESUME_SUPERVISOR: ports.service(["execute"]),
    PROGRAM_ASSETS: ports.assets,
  };
  return {
    claude: Schema.Struct({
      ...shared,
      ...QualifierClaudeInputs.fields,
      CLAUDE_ACCESS: ports.service([
        "resolveFreshAccess",
        "resolveInitialAccess",
        "resolveTurnAccess",
      ]),
      CLAUDE_EXECUTOR: ports.service(["forward"]),
      HARNESS_C_PRODUCT_CAPABILITIES: Schema.Struct({
        ...capabilities,
        [Keys.release]: ports.service([
          ...releaseMethods,
          "prepareClaudeIncarnation",
          "recordClaudeLoadedRelease",
          "catalog",
          "inventory",
        ]),
        claudeContinuationPublisher: ports.service(["publishContinuation"]),
      }),
    }).check(resumePhase),
    codex: Schema.Struct({
      ...shared,
      ...QualifierCodexInputs.fields,
      HARNESS_C_PRODUCT_CAPABILITIES: Schema.Struct(capabilities),
    }).check(resumePhase),
  };
}

const runtime = qualifierFacetConfigurationSchemas({
  service: (methods) =>
    Schema.declare<Fetcher>((value): value is Fetcher => hasQualifierMethods(value, methods)),
  assets: Schema.declare<Fetcher>((value): value is Fetcher =>
    hasQualifierMethods(value, ["fetch"]),
  ),
});
export const QualifierClaudeFacetConfiguration = runtime.claude;
export const QualifierCodexFacetConfiguration = runtime.codex;
export const assertQualifierClaudeFacetConfiguration = Schema.decodeUnknownSync(runtime.claude);
export const assertQualifierCodexFacetConfiguration = Schema.decodeUnknownSync(runtime.codex);

const decodeClaudeInputs = Schema.decodeUnknownSync(QualifierClaudeInputs);
const decodeCodexInputs = Schema.decodeUnknownSync(QualifierCodexInputs);

export function qualifierClaudeFacetInputs(
  environment: { readonly RUN_ID: string; readonly CONFIG_SHA256: string },
  variant: "baseline" | "hooks",
) {
  return decodeClaudeInputs({
    RUN_ID: environment.RUN_ID,
    CONFIG_SHA256: environment.CONFIG_SHA256,
    QUALIFIER_CLAUDE_VARIANT: variant,
  });
}

export function qualifierCodexFacetInputs(configuration: {
  readonly runId: string;
  readonly workerName: string;
}) {
  return decodeCodexInputs({
    QUALIFIER_CONFIGURATION: { runId: configuration.runId, workerName: configuration.workerName },
  });
}
