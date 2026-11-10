import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DriveDirectory from "../DriveDirectory.ts";
import type { MetadataState } from "../DriveMetadata.ts";
import {
  beginMetadataHash,
  hashMetadataChunk,
  metadataHashId,
  MetadataHashState,
} from "../DriveMetadataHash.ts";
import { at, failure } from "./hydrationError.ts";
import { DeltaState } from "../DriveDelta.ts";
import { InflateCheckpoint } from "../DriveInflate.ts";

export const HYDRATION_BYTES = 64 * 1024;
export const HYDRATION_DEPTH = 64;
const count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
export const HydrationCheckpoint = Schema.Union([
  Schema.Struct({
    format: Schema.Literal("drive-hydration-v1"),
    kind: Schema.Literal("pack"),
    headerLength: count.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
    payloadSize: count,
    baseOid: Schema.NullOr(oid),
    inflater: Schema.NullOr(InflateCheckpoint),
    streamDone: Schema.Boolean,
    delta: Schema.NullOr(DeltaState),
    pending: Schema.Uint8ArrayFromBase64.check(Schema.isMaxLength(HYDRATION_BYTES)),
    hash: MetadataHashState,
  }),
  Schema.Struct({
    format: Schema.Literal("drive-hydration-v1"),
    kind: Schema.Literal("remote"),
    size: count,
    hash: MetadataHashState,
  }),
]);
export type HydrationCheckpoint = typeof HydrationCheckpoint.Type;
export type PackCheckpoint = Extract<HydrationCheckpoint, { kind: "pack" }>;
const json = Schema.fromJsonString(HydrationCheckpoint);
export const decodeCheckpoint = Schema.decodeUnknownEffect(json, { onExcessProperty: "error" });
export const encodeCheckpoint = Schema.encodeEffect(json);

const safeSize = (size: number) => Number.isSafeInteger(size) && size >= 0;
const empty = new Uint8Array();
export const makeCheckpointCommit = Effect.fn("makeCheckpointCommit")(function* (driveId: string) {
  const drive = (yield* DriveDirectory.DriveDirectory).forDrive(driveId);
  return Effect.fn("DriveHydration.commit")(function* (
    state: MetadataState,
    checkpoint: HydrationCheckpoint,
    output: Uint8Array = empty,
    complete = false,
  ) {
    if (output.length > HYDRATION_BYTES) return yield* failure(state.oid, "range");
    const hash = yield* Effect.try({
      try: () => hashMetadataChunk(checkpoint.hash, output),
      catch: (cause) => failure(state.oid, "hash", cause),
    });
    if (complete && metadataHashId(hash) !== state.oid) return yield* failure(state.oid, "hash");
    const encoded = yield* at(state.oid, "checkpoint", encodeCheckpoint({ ...checkpoint, hash }));
    return (yield* at(
      state.oid,
      "state",
      drive.metadataAdvance({
        oid: state.oid,
        expectedRevision: state.revision,
        expectedBytesWritten: state.bytesWritten,
        chunks: output.length === 0 ? [] : [output],
        checkpoint: encoded,
        complete,
      }),
    )).state;
  });
});

export const loadCheckpoint = Effect.fn("DriveHydration.load")(function* (state: MetadataState) {
  if (state.checkpoint === null || state.checkpoint.length > 256 * 1024)
    return yield* failure(state.oid, "checkpoint");
  const cp = yield* at(state.oid, "checkpoint", decodeCheckpoint(state.checkpoint));
  const kind = state.source.kind === "pack" ? state.source.location.type : "blob";
  const size =
    cp.kind === "remote" ? cp.size : state.source.kind === "pack" ? state.source.location.size : -1;
  if (
    cp.kind !== state.source.kind ||
    !safeSize(size) ||
    cp.hash.length !== beginMetadataHash(kind, size).length + state.bytesWritten ||
    (state.source.kind === "remote" && state.source.size !== null && state.source.size !== size)
  )
    return yield* failure(state.oid, "checkpoint");
  if (
    cp.kind === "pack" &&
    ((cp.delta !== null &&
      (cp.delta.written !== state.bytesWritten ||
        cp.delta.resultSize !== size ||
        cp.baseOid === null)) ||
      (cp.baseOid === null &&
        (cp.pending.length !== 0 || cp.delta !== null || cp.payloadSize !== size)) ||
      (cp.streamDone && cp.inflater !== null) ||
      (cp.inflater !== null && cp.inflater.expectedSize !== cp.payloadSize))
  )
    return yield* failure(state.oid, "checkpoint");
  return cp;
});
