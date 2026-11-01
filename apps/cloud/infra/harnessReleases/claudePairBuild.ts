import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { candidateSha256 } from "./candidateOutput.ts";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ArtifactIdentity = Schema.Struct({
  artifactRef: Schema.String,
  artifactHash: Sha256,
  sourceIdentity: Sha256,
});
const PairBuild = Schema.Struct({
  schema: Schema.Literal("signalbox/claude-pair-build/v1"),
  status: Schema.Literal("builtin-inventory-pending"),
  createdAt: Schema.String,
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  sourceSha256: Sha256,
  trustedComputer: Schema.Struct({ sourceIdentity: Sha256, manifestSha256: Sha256 }),
  maxPreparedModuleBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  projectId: Schema.optionalKey(Schema.String),
  variants: Schema.Struct({ baseline: ArtifactIdentity, hooks: ArtifactIdentity }),
});
const decodePairBuild = Schema.decodeUnknownSync(PairBuild, { onExcessProperty: "error" });

export async function readClaudePairBuild(directory: string, sha256: string) {
  const bytes = await NodeFSP.readFile(NodePath.join(directory, "pair-build.json"));
  if (candidateSha256(bytes) !== sha256) throw new Error("CLAUDE_PAIR_BUILD_CHANGED");
  return decodePairBuild(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
