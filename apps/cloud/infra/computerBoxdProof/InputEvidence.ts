// @effect-diagnostics nodeBuiltinImport:off - receipts retain raw and region-comment-normalized build identities.
import * as NodeCrypto from "node:crypto";
import type { ProofSeed } from "./SeedProtocol.ts";

export function proofInputEvidence(seed: Pick<ProofSeed, "runner" | "executables">) {
  // Bundler region paths vary with the dependency store location. Keep the raw hash too.
  const withoutRegions = seed.runner.source
    .split("\n")
    .filter((line) => !line.startsWith("//#region "))
    .join("\n");
  return {
    runnerSha256: seed.runner.sha256,
    runnerWithoutRegionCommentsSha256: NodeCrypto.createHash("sha256")
      .update(withoutRegions)
      .digest("hex"),
    runnerBytes: Buffer.byteLength(seed.runner.source),
    executableSha256s: seed.executables.map((file) => file.sha256),
  };
}
