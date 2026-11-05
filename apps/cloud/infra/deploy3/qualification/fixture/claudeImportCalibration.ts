import { readRpcData, rpcStubOwner } from "../../../../src/rpc/Resources.ts";
import { createHarnessProcessFacetStub } from "../../../../src/harness/HarnessProcessFacet.ts";
import { createQualifierShardEnvironment } from "../shardEnvironment.ts";
import { claudeImportFacet } from "./claudeFacetInputs.ts";
import type { ClaudeImportCalibrationFacet } from "./claudeImportCalibrationFacet.ts";
import type { ClaudeVariant } from "./claudeScenario.ts";
import { readConfiguration } from "./configuration.ts";
import { assert } from "./common.ts";
import { proof, type QualifierEnvironment } from "./environment.ts";
import { qualifierFacetLoader } from "./loader.ts";

/** Uses the product's lazy facet loader, then discards the import-only personality. */
export async function calibrateClaudeImport(
  ctx: DurableObjectState,
  env: QualifierEnvironment,
  variant: ClaudeVariant,
) {
  const config = await readConfiguration(env.PROGRAM_ASSETS, env.CONFIG_SHA256);
  const cap = proof(env);
  using _capOwner = rpcStubOwner(cap);
  const key = `claude-import-calibration-${variant}-${env.RUN_ID}`;
  const environment = createQualifierShardEnvironment(
    env,
    qualifierFacetLoader(env, env.QUALIFIER_TAIL, ctx),
    cap,
  );
  const owner = createHarnessProcessFacetStub(
    ctx,
    environment,
    claudeImportFacet(config, variant),
    { shardOwner: "qualifier/claude-import-calibration", loaderId: key, facetKey: key },
  );
  const facet = owner.stub as typeof owner.stub &
    Pick<ClaudeImportCalibrationFacet, "observerCalibration">;
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
