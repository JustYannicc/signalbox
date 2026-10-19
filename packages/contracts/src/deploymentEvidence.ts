import * as Schema from "effect/Schema";

const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/i));

/** A host read for a linked pull request, independent of its PR-head checks. */
export const DeploymentEvidenceInput = Schema.Struct({
  threadId: Schema.String,
  url: Schema.String,
  runId: Schema.optional(Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/))),
});

export const DeploymentEvidence = Schema.Struct({
  commit: Commit,
  baseBranch: Schema.String,
  run: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      status: Schema.Literals(["pending", "failed", "succeeded"]),
      commit: Commit,
    }),
  ),
});

export type DeploymentEvidenceInput = typeof DeploymentEvidenceInput.Type;
export type DeploymentEvidence = typeof DeploymentEvidence.Type;
