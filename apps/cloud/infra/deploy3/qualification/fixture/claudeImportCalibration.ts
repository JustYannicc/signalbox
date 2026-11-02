import { readRpcData, rpcStubOwner } from "../../../../src/rpc/Resources.ts";
import { createHarnessProcessFacetStub } from "../../../../src/harness/processPlacement/facetLoader.ts";
import { createQualifierShardEnvironment } from "../shardEnvironment.ts";
import { claudeBootstrap, claudeFacet } from "./claudeFacetInputs.ts";
import type { ClaudeFacet } from "./claudeFacet.ts";
import type { calibrateClaudePreparedRelease } from "./claudeCalibration.ts";
import type { ClaudeVariant } from "./claudeScenario.ts";
import { readConfiguration } from "./configuration.ts";
import { assert } from "./common.ts";
import { proof, type QualifierEnvironment } from "./environment.ts";
import { qualifierFacetLoader } from "./loader.ts";

export interface ClaudeImportCalibrationResult {
  readonly identity: { readonly facetNonce: string };
  readonly observed: {
    readonly incarnation: string;
    readonly invocationId: string;
    readonly selectedReleaseId: string;
    readonly selectedReleaseHash: string;
    readonly imported: Awaited<ReturnType<typeof calibrateClaudePreparedRelease>>;
    readonly nativeStarted: false;
  };
  readonly loaderId: string;
  readonly nativeStarted: false;
}

/** Uses the product's lazy facet loader, then discards the import-only personality. */
export async function calibrateClaudeImport(
  ctx: DurableObjectState,
  env: QualifierEnvironment,
  variant: ClaudeVariant,
): Promise<ClaudeImportCalibrationResult> {
  const config = await readConfiguration(env.PROGRAM_ASSETS, env.CONFIG_SHA256);
  const cap = proof(env);
  using _capOwner = rpcStubOwner(cap);
  const key = `claude-import-calibration-${variant}-${env.RUN_ID}`;
  const environment = createQualifierShardEnvironment(
    env,
    qualifierFacetLoader(env, env.QUALIFIER_TAIL),
    cap,
  );
  const owner = createHarnessProcessFacetStub(
    ctx,
    environment,
    {
      ...claudeFacet(config, variant),
      productBootstrap: claudeBootstrap(config, variant),
      targetPreparedRelease: config.claude.expected[variant],
    },
    { shardOwner: "qualifier/claude-import-calibration", loaderId: key, facetKey: key },
  );
  const facet = owner.stub as typeof owner.stub & Pick<ClaudeFacet, "observerCalibration">;
  try {
    const identity = await readRpcData(facet.identity());
    const observed = await readRpcData(facet.observerCalibration({ invocationId: key }));
    assert(
      observed.incarnation === identity.facetNonce && observed.nativeStarted === false,
      "Claude import calibration changed identity or started the CLI",
    );
    return { identity, observed, loaderId: key, nativeStarted: false as const };
  } finally {
    try {
      ctx.facets.abort(key, "Claude import calibration completed without CLI execution");
      ctx.facets.delete(key);
    } finally {
      owner[Symbol.dispose]();
    }
  }
}
