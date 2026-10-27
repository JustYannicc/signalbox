import * as Schema from "effect/Schema";
import { id } from "../durableState/shared.ts";

export const NATIVE_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const creationInvocationKey = (runId: string) =>
  `harness-process-creation-invocation/v1/${encodeURIComponent(runId)}`;

const decodeId = Schema.decodeUnknownSync(id);

export async function creationRecoveryIds(drainOperationId: string) {
  // Hash the full input so suffixes stay bounded without truncating operation identity.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(drainOperationId)),
  );
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return {
    evidenceId: decodeId(`cold-recovery/${key}/undispatched`),
    acknowledgementId: decodeId(`cold-recovery/${key}/initial-disposed`),
  };
}
