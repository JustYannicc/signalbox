import * as Schema from "effect/Schema";
import type { HarnessReleaseArtifact, HarnessReleaseLedger } from "./HarnessReleaseLedger.ts";

const NonEmpty = Schema.String.check(Schema.isPattern(/\S/));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Artifact = Schema.Struct({
  provider: Schema.Literal("claude-code"),
  releaseId: NonEmpty,
  artifactHash: Sha256,
  artifactRef: NonEmpty,
  sourceIdentity: Sha256,
  fixtureIdentity: NonEmpty,
  createdAt: NonEmpty,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const ClaudeReleaseVariants = Schema.Struct({
  baseline: Schema.Struct({ variant: Schema.Literal("baseline"), fullArtifact: Artifact }),
  hooks: Schema.Struct({ variant: Schema.Literal("hooks"), fullArtifact: Artifact }),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export type ClaudeReleaseVariants = typeof ClaudeReleaseVariants.Type;

const decode = Schema.decodeUnknownSync(ClaudeReleaseVariants, {
  onExcessProperty: "error",
  reportInput: false,
});
const fields = [
  "provider",
  "releaseId",
  "artifactHash",
  "artifactRef",
  "sourceIdentity",
  "fixtureIdentity",
  "createdAt",
] as const;

export function sameClaudeReleaseArtifact(
  left: HarnessReleaseArtifact,
  right: HarnessReleaseArtifact,
) {
  return fields.every((field) => left[field] === right[field]);
}

/** Decoding classifies only explicit entries. Runtime qualification remains ledger-owned. */
export function decodeClaudeReleaseVariants(input: unknown): ClaudeReleaseVariants {
  const catalog = decode(input);
  const baseline = catalog.baseline.fullArtifact;
  const hooks = catalog.hooks.fullArtifact;
  for (const field of ["releaseId", "artifactHash", "artifactRef", "sourceIdentity"] as const)
    if (baseline[field] === hooks[field]) throw new Error(`CLAUDE_VARIANTS_SHARED_${field}`);
  for (const entry of [baseline, hooks])
    if (entry.artifactRef !== `sha256:${entry.artifactHash}`)
      throw new Error("CLAUDE_VARIANTS_ARTIFACT_REF_MISMATCH");
  return catalog;
}

export function encodeClaudeReleaseVariants(input: ClaudeReleaseVariants): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(decodeClaudeReleaseVariants(input)));
}

export function resolveClaudeReleaseVariants(
  input: unknown,
  ledger: Pick<HarnessReleaseLedger, "getArtifact">,
) {
  const catalog = decodeClaudeReleaseVariants(input);
  for (const { fullArtifact } of [catalog.baseline, catalog.hooks]) {
    const stored = ledger.getArtifact("claude-code", fullArtifact.releaseId);
    if (!stored || !sameClaudeReleaseArtifact(stored, fullArtifact))
      throw new Error("CLAUDE_VARIANTS_LEDGER_RECORD_MISMATCH");
  }
  return catalog;
}
