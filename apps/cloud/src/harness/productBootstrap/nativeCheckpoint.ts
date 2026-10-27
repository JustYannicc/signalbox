import {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { HarnessCheckpoint } from "../Harness.ts";
import type { HarnessRunArtifact } from "../HarnessRunStore.ts";

const HarnessReleaseSchema = Schema.Struct({
  harness: Schema.Literals(["claude-code", "codex"]),
  version: Schema.String,
  manifestSha256: Schema.String,
  modules: Schema.Record(
    Schema.String,
    Schema.Struct({ bytes: Schema.Number, sha256: Schema.String }),
  ),
});
const HarnessSnapshotSchema = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
  messages: Schema.Array(OrchestrationV2ConversationMessage),
  runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
  providerPayload: Schema.optionalKey(Schema.Unknown),
});
const HarnessCheckpointSchema = Schema.Struct({
  release: HarnessReleaseSchema,
  providerSession: OrchestrationV2ProviderSession,
  snapshot: HarnessSnapshotSchema,
  revision: Schema.Struct({ commit: Schema.String }),
});
const NativeCheckpointEnvelopeSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  nativeSessionId: Schema.String,
  checkpoint: HarnessCheckpointSchema,
});
const nativeCheckpointCodec = Schema.fromJsonString(
  Schema.toCodecJson(NativeCheckpointEnvelopeSchema),
);
const decodeNativeCheckpointEnvelope = Schema.decodeSync(nativeCheckpointCodec);
export const encodeHarnessCProductNativeCheckpoint = Schema.encodeSync(nativeCheckpointCodec);

export class HarnessCProductNativeCheckpointError extends Error {
  readonly _tag = "HarnessCProductNativeCheckpointError";
}

export interface HarnessCProductNativeCheckpointEnvelope {
  readonly schemaVersion: 1;
  readonly nativeSessionId: string;
  readonly checkpoint: HarnessCheckpoint;
}

/** Verifies the referenced bytes before using their serialized product checkpoint. */
export async function decodeHarnessCProductNativeCheckpoint(input: {
  readonly reference: HarnessRunArtifact;
  readonly expectedNativeSessionId: string;
  readonly bytes: Uint8Array;
}): Promise<HarnessCProductNativeCheckpointEnvelope> {
  if (!(input.bytes instanceof Uint8Array))
    throw new HarnessCProductNativeCheckpointError("The native checkpoint payload is missing.");
  if (input.bytes.byteLength !== input.reference.bytes)
    throw new HarnessCProductNativeCheckpointError("The native checkpoint byte count changed.");
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(input.bytes).buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (sha256 !== input.reference.sha256)
    throw new HarnessCProductNativeCheckpointError("The native checkpoint hash does not match.");

  let decoded: HarnessCProductNativeCheckpointEnvelope;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    decoded = decodeNativeCheckpointEnvelope(text);
  } catch (cause) {
    throw new HarnessCProductNativeCheckpointError("The native checkpoint payload is malformed.", {
      cause,
    });
  }
  if (decoded.nativeSessionId !== input.expectedNativeSessionId)
    throw new HarnessCProductNativeCheckpointError(
      "The native checkpoint belongs to another native session.",
    );
  if (
    decoded.checkpoint.snapshot.providerThread.nativeThreadRef === null ||
    decoded.checkpoint.snapshot.providerThread.nativeThreadRef.nativeId === null
  )
    throw new HarnessCProductNativeCheckpointError(
      "The native checkpoint has no provider session to restore.",
    );
  if (
    decoded.checkpoint.snapshot.providerThread.nativeThreadRef.nativeId !==
    input.expectedNativeSessionId
  )
    throw new HarnessCProductNativeCheckpointError(
      "The provider checkpoint belongs to another native session.",
    );
  return decoded;
}
