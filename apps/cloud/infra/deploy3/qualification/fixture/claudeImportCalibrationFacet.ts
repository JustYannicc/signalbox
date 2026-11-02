import { DurableObject } from "cloudflare:workers";
import {
  assertQualifierClaudeCalibrationFacetConfiguration,
  type QualifierClaudeCalibrationFacetConfiguration,
} from "../claudeCalibrationFacetContract.ts";
import { claudeCapability } from "./claudeHostOptions.ts";
import { readClaudeFacetConfiguration } from "./claudeFacetConfiguration.ts";
import { observeClaudePreparedImport } from "./claudeCalibrationObservation.ts";

/** Imports the selected real release without constructing a native session or its authorities. */
export class ClaudeImportCalibrationFacet extends DurableObject<
  typeof QualifierClaudeCalibrationFacetConfiguration.Type
> {
  // @effect-diagnostics-next-line cryptoRandomUUID:off - platform construction assigns the inert facet identity.
  readonly facetNonce = crypto.randomUUID();

  identity() {
    return { facetNonce: this.facetNonce };
  }

  async observerCalibration(input: { readonly invocationId: string }) {
    const env = assertQualifierClaudeCalibrationFacetConfiguration(this.env);
    const capability = claudeCapability(env);
    return observeClaudePreparedImport({
      ctx: this.ctx,
      capability,
      configuration: await readClaudeFacetConfiguration(env, capability),
      assets: env.PROGRAM_ASSETS,
      release: env.HARNESS_C_TARGET_PREPARED_RELEASE,
      facetNonce: this.facetNonce,
      invocationId: input.invocationId,
    });
  }

  startFresh(): never {
    throw new Error("CLAUDE_INERT_FACET_NATIVE_DISPATCH_FORBIDDEN");
  }
  prepareInert(): never {
    throw new Error("CLAUDE_INERT_FACET_NATIVE_DISPATCH_FORBIDDEN");
  }
  run(): never {
    throw new Error("CLAUDE_INERT_FACET_NATIVE_DISPATCH_FORBIDDEN");
  }
  loadedPreparedRelease(): never {
    throw new Error("CLAUDE_INERT_FACET_NATIVE_DISPATCH_FORBIDDEN");
  }
}
