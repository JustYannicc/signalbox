import * as Schema from "effect/Schema";
import type { Deploy3ControlComment, Deploy3RegisteredControl } from "./controlRegistry.ts";
import { parseDeploy3Name } from "./deadline.ts";
import { isoAt } from "./platform.ts";

export const OWNER_TEARDOWN_MARKER = "<!-- signalbox-deploy3-owner-teardown-v1 -->\n";
const OwnerTeardown = Schema.Struct({
  schema: Schema.Literal("sb1070/deploy3-owner-teardown/v1"),
  runId: Schema.String,
  registrationSha256: Schema.String,
  workerName: Schema.String,
  workerId: Schema.String,
  namespaceIds: Schema.Array(Schema.String),
  tailIds: Schema.Array(Schema.String),
  verifiedAtUtc: Schema.String,
  absenceVerified: Schema.Literal(true),
  verificationSha256: Schema.String,
});
export type Deploy3OwnerTeardown = typeof OwnerTeardown.Type;
const decode = Schema.decodeUnknownSync(OwnerTeardown);
const decodeJson = Schema.decodeSync(Schema.fromJsonString(OwnerTeardown));
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const resourceIds = (values: readonly string[]) =>
  values.length <= 32 &&
  new Set(values).size === values.length &&
  values.every((value) => /^[A-Za-z0-9_-]{1,200}$/.test(value));
function sameIds(left: readonly string[], right: readonly string[]) {
  const sortedRight = [...right].sort();
  return (
    left.length === right.length && [...left].sort().every((value, i) => value === sortedRight[i])
  );
}

export function ownerTeardownBody(value: unknown) {
  const proof = decode(value);
  const parsed = parseDeploy3Name(proof.workerName);
  const verifiedAt = Date.parse(proof.verifiedAtUtc);
  if (
    !parsed ||
    parsed.role !== "workload" ||
    parsed.runId !== proof.runId ||
    !/^[a-f0-9]{32}$/.test(proof.workerId) ||
    !digest(proof.registrationSha256) ||
    !digest(proof.verificationSha256) ||
    !resourceIds(proof.namespaceIds) ||
    !resourceIds(proof.tailIds) ||
    !Number.isSafeInteger(verifiedAt) ||
    isoAt(verifiedAt) !== proof.verifiedAtUtc
  )
    throw new Error("Invalid owner teardown proof");
  return OWNER_TEARDOWN_MARKER + JSON.stringify(proof);
}

/** A trusted controller's resource closeout does not assert that a credential expired. */
export function ownerTeardownIsFinal(
  comments: readonly Deploy3ControlComment[],
  trustedWriterIds: readonly number[],
  state: Deploy3RegisteredControl,
  nowMs: number,
) {
  return comments.some((comment) => {
    if (
      comment.user.id !== state.controllerWriterId ||
      !trustedWriterIds.includes(comment.user.id) ||
      !comment.body.startsWith(OWNER_TEARDOWN_MARKER)
    )
      return false;
    try {
      const proof = decodeJson(comment.body.slice(OWNER_TEARDOWN_MARKER.length));
      return (
        comment.id > state.registrationId &&
        ownerTeardownBody(proof) === comment.body &&
        proof.registrationSha256 === state.registrationSha256 &&
        proof.runId === state.registration.runId &&
        proof.workerName === state.registration.workerName &&
        proof.workerId === state.registration.workerId &&
        sameIds(proof.namespaceIds, state.registration.namespaceIds) &&
        sameIds(proof.tailIds, state.registration.tailIds) &&
        Date.parse(proof.verifiedAtUtc) >= Date.parse(state.registration.deployedAtUtc) &&
        Date.parse(proof.verifiedAtUtc) <= nowMs
      );
    } catch {
      return false;
    }
  });
}
