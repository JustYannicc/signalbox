import * as Schema from "effect/Schema";
import { createHarnessProcessFacetEnvironment } from "../../../src/harness/HarnessProcessFacetEnvironment.ts";
import { createQualifierClaudeFacetEnvironment } from "./claudeFacetEnvironment.ts";
import { qualifierFacetConfigurationSchemas } from "./facetEnvironmentContract.ts";
import {
  QualifierPlannedConfiguration,
  QualifierShardPlannedConfiguration,
} from "./environmentContract.ts";
import { createQualifierShardEnvironment } from "./shardEnvironment.ts";
import { claudeBootstrap, claudeFacet } from "./fixture/claudeFacetInputs.ts";
import { codexFacet } from "./fixture/codexFacetInputs.ts";
import { claudeLane } from "./fixture/claudeScenario.ts";
import type { Configuration } from "./fixture/configuration.ts";
import { control, publisherKey } from "./fixture/common.ts";

const NonEmpty = Schema.String.check(Schema.isPattern(/\S/u));
const NamespaceReference = Schema.Struct({
  type: Schema.Literal("namespace-stub"),
  namespace: Schema.Struct({
    type: Schema.Literal("durable_object_namespace"),
    resourceId: NonEmpty,
    className: NonEmpty,
  }),
  name: NonEmpty,
});
const EntrypointReference = Schema.Struct({
  type: Schema.Literal("entrypoint"),
  workerName: NonEmpty,
  entrypoint: NonEmpty,
});
const ServiceReference = Schema.Union([
  NamespaceReference,
  EntrypointReference,
  QualifierPlannedConfiguration.fields.QUALIFIER_COMMANDS,
]);
const planned = qualifierFacetConfigurationSchemas({
  service: () => ServiceReference,
  assets: EntrypointReference,
});
const decodeClaude = Schema.decodeUnknownSync(planned.claude);
const decodeCodex = Schema.decodeUnknownSync(planned.codex);
const decodeShard = Schema.decodeUnknownSync(QualifierShardPlannedConfiguration);

/** Runs the shipping environment constructors over planned resources, without opening a Worker. */
export function validateQualifierFacetEnvironments(
  rawEnvironment: unknown,
  configuration: Configuration,
) {
  const outer = decodeShard(rawEnvironment);
  if (outer.RUN_ID !== configuration.runId || outer.WORKER_NAME !== configuration.workerName)
    throw new Error("DEPLOY3_FACET_CONFIGURATION_IDENTITY_MISMATCH");
  const stub = (
    namespace: {
      readonly type: "durable_object_namespace";
      readonly resourceId: string;
      readonly className: string;
    },
    name: string,
  ) => ({
    type: "namespace-stub" as const,
    namespace,
    name,
  });
  const capability = stub(outer.QUALIFIER, outer.RUN_ID);
  const shard = createQualifierShardEnvironment(outer, outer.LOADER, capability);
  decodeShard(shard);
  const assetEntrypoint = {
    type: "entrypoint" as const,
    workerName: outer.WORKER_NAME,
    entrypoint: "HarnessProgramAssetsBinding",
  };
  const authorities = stub(outer.CLAUDE_FIXTURES, outer.RUN_ID);
  const results = [];
  for (const provider of ["baseline", "hooks", "codex"] as const) {
    const facet =
      provider === "codex" ? codexFacet(configuration) : claudeFacet(configuration, provider);
    const release =
      provider === "codex"
        ? configuration.expectedRelease
        : configuration.claude.expected[provider];
    const bootstrap =
      provider === "codex"
        ? {
            provider: "codex" as const,
            preparedReleaseId: release.artifact.releaseId,
            restoreMode: "same-variant-serialized-checkpoint" as const,
          }
        : claudeBootstrap(configuration, provider);
    const runId = provider === "codex" ? outer.RUN_ID : claudeLane(outer.RUN_ID, provider).runId;
    for (const phase of ["fresh", "restored"] as const) {
      const identity = {
        shardOwner: `combined/${runId}`,
        loaderId: `planned/${provider}/${phase}`,
        facetKey: `planned/${provider}/${phase}`,
      };
      const stores = {
        HARNESS_RESUME_RUN_ID: runId,
        HARNESS_RESUME_CONTROL: control(phase === "fresh" ? 1 : 2),
        HARNESS_RESUME_RUN_STORE: stub(outer.HARNESS_RUN_STORE, runId),
        HARNESS_RESUME_FILES_STORE: stub(outer.HARNESS_FILES_STORE, runId),
        HARNESS_RESUME_SUPERVISOR: stub(outer.HARNESS_THREAD_SUPERVISOR, runId),
      };
      const resumeFacetEnv =
        phase === "fresh"
          ? { ...stores, HARNESS_RESUME_CREATION: true as const }
          : {
              ...stores,
              HARNESS_RESUME_PUBLISHER: {
                generation: 2,
                facetNonce: `planned/${provider}/prior-facet`,
                publisherKey: publisherKey(2),
              },
            };
      const environment = createHarnessProcessFacetEnvironment(
        { ...facet, productBootstrap: bootstrap, targetPreparedRelease: release, resumeFacetEnv },
        shard,
        identity,
        { exports: { HarnessProgramAssetsBinding: () => assetEntrypoint } },
      );
      const final =
        provider === "codex"
          ? environment
          : createQualifierClaudeFacetEnvironment(environment, shard, provider, {
              access: authorities,
              executor: authorities,
              continuations: authorities,
            });
      if (provider === "codex") decodeCodex(final);
      else decodeClaude(final);
      results.push({ provider, phase, environment: final });
    }
  }
  return results;
}
