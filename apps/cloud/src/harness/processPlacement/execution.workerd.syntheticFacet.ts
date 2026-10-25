export const syntheticFacetModule = `import { DurableObject } from "cloudflare:workers";

let moduleNonce;
const getModuleNonce = () => (moduleNonce ??= crypto.randomUUID());

export class SyntheticFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.facetNonce = crypto.randomUUID();
    this.phases = [];
    this.identityCalls = 0;
    this.identityMismatchCall = Number(env.IDENTITY_MISMATCH_CALL ?? "0");
    this.disposalFailures = Number(env.DISPOSAL_FAILURES ?? "0");
    this.invocationFailures = Number(env.INVOCATION_FAILURES ?? "0");
  }

  identity() {
    this.identityCalls++;
    return {
      facetNonce:
        this.identityCalls === this.identityMismatchCall
          ? this.facetNonce + "-mismatch"
          : this.facetNonce,
    };
  }

  prepareInert(input) {
    // Synthetic routing fixture only. Production preparation comes from HarnessRequestFacet.
    return {
      facetNonce: this.facetNonce,
      nativeSessionId: input.nativeSessionId,
      checkpoint: {
        native: { id: input.checkpointId, bytes: 0, sha256: "0".repeat(64) },
        filesystem: {
          id: input.checkpointId + "-filesystem",
          bytes: 0,
          sha256: input.manifestRevision,
        },
      },
      manifestRevision: input.manifestRevision,
      joined: { invocationRpc: true, fetch: true, ports: true },
    };
  }

  async run(input) {
    this.phases.push("invoke");
    if (this.invocationFailures > 0) {
      this.invocationFailures--;
      throw new Error("Synthetic request failed before its result was observed.");
    }
    return {
      action: "committed",
      snapshot: {
        facetNonce: this.facetNonce,
        moduleNonce: getModuleNonce(),
        constructorNonce: this.facetNonce,
        requestId: input.requestId,
        generation: input.publisher.generation,
        phases: [...this.phases],
      },
    };
  }

  async dispose(expectedFacetNonce) {
    if (expectedFacetNonce !== this.facetNonce)
      throw new Error("Synthetic request facet disposal targeted another constructor.");
    this.phases.push("dispose");
    if (this.disposalFailures > 0) {
      this.disposalFailures--;
      throw new Error("Synthetic facet disposal failed.");
    }
  }
}`;
