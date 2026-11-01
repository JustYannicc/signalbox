import * as Schema from "effect/Schema";
import { bootstrapBody, type Deploy3Bootstrap } from "./bootstrapRegistry.ts";
import { controlDigest, type Deploy3ControlComment } from "./controlRegistry.ts";
import { parseDeploy3Name } from "./deadline.ts";
import { isoAt } from "./platform.ts";

export const BOOTSTRAP_TEARDOWN_MARKER = "<!-- signalbox-deploy3-bootstrap-teardown-v1 -->\n";
const BootstrapTeardown = Schema.Struct({
  schema: Schema.Literal("sb1070/deploy3-bootstrap-teardown/v1"),
  runId: Schema.String,
  bootstrapSha256: Schema.String,
  workerName: Schema.String,
  operatorTokenId: Schema.String,
  verifiedAtUtc: Schema.String,
  absenceVerified: Schema.Literal(true),
  verificationSha256: Schema.String,
});
export type Deploy3BootstrapTeardown = typeof BootstrapTeardown.Type;
const decode = Schema.decodeUnknownSync(BootstrapTeardown);
const decodeJson = Schema.decodeSync(Schema.fromJsonString(BootstrapTeardown));

export function bootstrapTeardownBody(value: unknown) {
  const proof = decode(value);
  const parsed = parseDeploy3Name(proof.workerName);
  const verifiedAt = Date.parse(proof.verifiedAtUtc);
  if (
    !parsed ||
    parsed.role !== "workload" ||
    parsed.runId !== proof.runId ||
    !/^[a-f0-9]{64}$/.test(proof.bootstrapSha256) ||
    !/^[a-f0-9]{64}$/.test(proof.verificationSha256) ||
    !/^[a-f0-9]{32}$/.test(proof.operatorTokenId) ||
    !Number.isSafeInteger(verifiedAt) ||
    isoAt(verifiedAt) !== proof.verifiedAtUtc
  )
    throw new Error("Invalid bootstrap teardown proof");
  return BOOTSTRAP_TEARDOWN_MARKER + JSON.stringify(proof);
}

/** The bootstrap writer can close verified resource absence without asserting token expiry. */
export async function bootstrapTeardownIsFinal(
  comments: readonly Deploy3ControlComment[],
  trustedWriterIds: readonly number[],
  bootstrap: Deploy3Bootstrap,
  nowMs: number,
) {
  const body = bootstrapBody(bootstrap);
  const original = comments.find(
    (row) => row.body === body && trustedWriterIds.includes(row.user.id),
  );
  if (!original) return false;
  const bootstrapSha256 = await controlDigest(body);
  return comments.some((comment) => {
    if (
      comment.id <= original.id ||
      comment.user.id !== original.user.id ||
      !comment.body.startsWith(BOOTSTRAP_TEARDOWN_MARKER)
    )
      return false;
    try {
      const proof = decodeJson(comment.body.slice(BOOTSTRAP_TEARDOWN_MARKER.length));
      return (
        bootstrapTeardownBody(proof) === comment.body &&
        proof.bootstrapSha256 === bootstrapSha256 &&
        proof.runId === bootstrap.runId &&
        proof.workerName === bootstrap.workerName &&
        proof.operatorTokenId === bootstrap.operatorTokenId &&
        Date.parse(proof.verifiedAtUtc) >= Date.parse(bootstrap.startedAtUtc) &&
        Date.parse(proof.verifiedAtUtc) <= nowMs
      );
    } catch {
      return false;
    }
  });
}
