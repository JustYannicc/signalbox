import { createHarnessProcessFacetEnvironment } from "../../../src/harness/HarnessProcessFacetEnvironment.ts";
import { HARNESS_C_PRODUCT_CAPABILITY_KEYS as Keys } from "../../../src/harness/HarnessCProductCapabilities.ts";
import { createQualifierClaudeFacetEnvironment } from "./claudeFacetEnvironment.ts";
import { assertQualifierClaudeFacetConfiguration } from "./facetEnvironmentContract.ts";
import { claudeImportFacet } from "./fixture/claudeFacetInputs.ts";
import type { Configuration } from "./fixture/configuration.ts";

/** Replays constructor configuration; descriptor methods must stay uncalled before a Worker exists. */
export function validateClaudeImportFacetEnvironments(
  configuration: Pick<Configuration, "runId" | "claude">,
  configSha256: string,
) {
  let rpcCalls = 0;
  const port = new Proxy(
    {},
    {
      get: () => () => {
        rpcCalls++;
        throw new Error("DEPLOY3_INERT_CONSTRUCTOR_INVOKED_RPC");
      },
    },
  );
  const capability = port as Fetcher;
  const source = { RUN_ID: configuration.runId, CONFIG_SHA256: configSha256 };
  const environment = {
    PROGRAM_ASSETS: capability,
    HARNESS_C_PRODUCT_CAPABILITIES: Object.fromEntries(
      [...Object.values(Keys), "qualifierCommands"].map((key) => [key, capability]),
    ),
  };
  const checked = (["baseline", "hooks"] as const).map((variant) => {
    const key = `claude-import-calibration-${variant}-${configuration.runId}`;
    const initial = createHarnessProcessFacetEnvironment(
      claudeImportFacet(configuration, variant),
      environment,
      { shardOwner: "qualifier/claude-import-calibration", loaderId: key, facetKey: key },
      { exports: { HarnessProgramAssetsBinding: () => capability } },
    );
    const final = createQualifierClaudeFacetEnvironment(initial, source, variant, {
      access: capability,
      executor: capability,
      continuations: capability,
    });
    assertQualifierClaudeFacetConfiguration(final);
    return { variant, status: "passed" as const };
  });
  return {
    schema: "signalbox/deploy3-inert-constructor-replay/v1",
    checked,
    rpcCalls,
    nativeStarted: false,
  };
}
