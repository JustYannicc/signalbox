import * as Effect from "effect/Effect";
import * as DriveDirectory from "../DriveDirectory.ts";
import * as DrivePacks from "../DrivePacks.ts";
import { beginDelta, stepDelta } from "../DriveDelta.ts";
import { inflateMetadataStep } from "../DriveInflate.ts";
import { beginMetadataHash } from "../DriveMetadataHash.ts";
import type { MetadataState } from "../DriveMetadata.ts";
import type { Oid } from "../git/gitObjects.ts";
import { at, failure } from "./hydrationError.ts";
import {
  makeCheckpointCommit,
  HYDRATION_BYTES,
  HYDRATION_DEPTH,
  type PackCheckpoint,
} from "./hydrationState.ts";
import * as Hex from "effect/encoding/Hex";
import type { ObjectType } from "../git/gitObjects.ts";

export interface HydrationHeader {
  readonly kind: ObjectType | "ofs_delta" | "ref_delta";
  readonly size: number;
  readonly length: number;
  readonly baseDistance?: number;
  readonly baseOid?: string;
}

/** A Git pack header fits in 64 bytes, including its 20-byte base reference. */
export const hydrationHeader = (oid: Oid, bytes: Uint8Array) =>
  Effect.try({
    try: (): HydrationHeader => {
      let at = 0;
      const next = () => {
        const byte = bytes[at++];
        if (byte === undefined || at > 64) throw new Error("Truncated pack header.");
        return byte;
      };
      let byte = next();
      const kinds = [
        null,
        "commit",
        "tree",
        "blob",
        "tag",
        null,
        "ofs_delta",
        "ref_delta",
      ] as const;
      const kind = kinds[(byte >> 4) & 7];
      if (kind === null || kind === undefined) throw new Error("Invalid pack object kind.");
      let size = byte & 15;
      let shift = 4;
      while (byte & 0x80) {
        byte = next();
        size += (byte & 0x7f) * 2 ** shift;
        if (!Number.isSafeInteger(size) || shift > 46) throw new Error("Invalid pack object size.");
        shift += 7;
      }
      if (kind === "ofs_delta") {
        byte = next();
        let baseDistance = byte & 0x7f;
        while (byte & 0x80) {
          byte = next();
          baseDistance = (baseDistance + 1) * 128 + (byte & 0x7f);
          if (!Number.isSafeInteger(baseDistance)) throw new Error("Invalid delta distance.");
        }
        if (baseDistance === 0) throw new Error("Invalid delta distance.");
        return { kind, size, length: at, baseDistance };
      }
      if (kind === "ref_delta") {
        if (at + 20 > bytes.length) throw new Error("Truncated delta reference.");
        const baseOid = Hex.encode(bytes.subarray(at, at + 20));
        return { kind, size, length: at + 20, baseOid };
      }
      return { kind, size, length: at };
    },
    catch: (cause) => failure(oid, "header", cause),
  });

const safeSize = (size: number) => Number.isSafeInteger(size) && size >= 0;
const empty = new Uint8Array();
export const makePackHydration = Effect.fn("makePackHydration")(function* (driveId: string) {
  const drive = (yield* DriveDirectory.DriveDirectory).forDrive(driveId);
  const commit = yield* makeCheckpointCommit(driveId);
  const packs = yield* DrivePacks.DrivePacks;
  const range = Effect.fn("DriveHydration.range")(function* (
    state: MetadataState,
    offset: number,
    length: number,
  ) {
    if (state.source.kind !== "pack" || length < 1 || length > HYDRATION_BYTES)
      return yield* failure(state.oid, "range");
    const location = state.source.location;
    if (!safeSize(offset) || !safeSize(offset + length) || offset + length > location.length)
      return yield* failure(state.oid, "range");
    const bytes = yield* at(
      state.oid,
      "range",
      packs.range(
        location.storageDriveId ?? driveId,
        location.pack,
        location.offset + offset,
        length,
      ),
    );
    if (bytes.length !== length) return yield* failure(state.oid, "range");
    return bytes;
  });
  const initializePack = Effect.fn("DriveHydration.initializePack")(function* (
    state: MetadataState,
    visited: ReadonlySet<Oid>,
  ) {
    if (state.source.kind !== "pack" || state.bytesWritten !== 0)
      return yield* failure(state.oid, "checkpoint");
    const location = state.source.location;
    const header = yield* hydrationHeader(
      state.oid,
      yield* range(state, 0, Math.min(64, location.length)),
    );
    if (header.length >= location.length) return yield* failure(state.oid, "header");
    let baseOid: Oid | null = null;
    if (header.kind === "ofs_delta" || header.kind === "ref_delta") {
      if (header.kind === "ofs_delta" && header.baseDistance! > location.offset)
        return yield* failure(state.oid, "dependency");
      const base =
        header.kind === "ofs_delta"
          ? yield* at(
              state.oid,
              "dependency",
              drive.locateAt(location.pack, location.offset - header.baseDistance!),
            )
          : (yield* at(state.oid, "dependency", drive.locate([header.baseOid!])))[0];
      if (
        base === null ||
        base === undefined ||
        visited.has(base.oid) ||
        visited.size >= HYDRATION_DEPTH ||
        base.type !== location.type
      )
        return yield* failure(state.oid, "dependency");
      baseOid = base.oid;
      yield* at(baseOid, "state", drive.metadataBegin(baseOid, { kind: "pack", location: base }));
    } else if (header.kind !== location.type || header.size !== location.size) {
      return yield* failure(state.oid, "header");
    }
    return yield* commit(state, {
      format: "drive-hydration-v1",
      kind: "pack",
      headerLength: header.length,
      payloadSize: header.size,
      baseOid,
      inflater: null,
      streamDone: false,
      delta: null,
      pending: empty,
      hash: beginMetadataHash(location.type, location.size),
    });
  });
  const packStep = Effect.fn("DriveHydration.packStep")(function* (
    state: MetadataState,
    cp: PackCheckpoint,
    base: MetadataState | null,
  ) {
    if (state.source.kind !== "pack") return yield* failure(state.oid, "source");
    if (cp.baseOid !== null && (base === null || !base.complete))
      return yield* failure(state.oid, "dependency");
    if (
      base !== null &&
      (cp.pending.length !== 0 || cp.streamDone || cp.delta?.phase.kind === "copy")
    ) {
      const delta = cp.delta ?? beginDelta(base.bytesWritten, state.source.location.size);
      let result = yield* at(
        state.oid,
        "delta",
        stepDelta({ state: delta, input: cp.pending, sourceEnded: cp.streamDone }),
      );
      if (result.needBase !== undefined) {
        const bytes = yield* at(
          state.oid,
          "dependency",
          drive.metadataBytes(base.oid, result.needBase.offset, result.needBase.length),
        );
        if (bytes.bytes.length === 0 || bytes.bytes.length > result.needBase.length)
          return yield* failure(state.oid, "dependency");
        const consumed = result.consumed;
        result = yield* at(
          state.oid,
          "delta",
          stepDelta({
            state: result.state,
            input: cp.pending.subarray(consumed),
            sourceEnded: cp.streamDone,
            base: { offset: result.needBase.offset, bytes: bytes.bytes },
          }),
        );
        result = { ...result, consumed: consumed + result.consumed };
      }
      return yield* commit(
        state,
        {
          ...cp,
          delta: result.state,
          pending: cp.pending.slice(result.consumed),
        },
        result.output,
        result.done,
      );
    }
    if (cp.streamDone) return yield* failure(state.oid, "checkpoint");
    const offset = cp.inflater?.sourceOffset ?? 0;
    const remaining = state.source.location.length - cp.headerLength - offset;
    if (remaining < 0) return yield* failure(state.oid, "checkpoint");
    const input =
      remaining === 0
        ? empty
        : yield* range(state, cp.headerLength + offset, Math.min(HYDRATION_BYTES, remaining));
    const result = yield* at(
      state.oid,
      "inflate",
      inflateMetadataStep({
        checkpoint: cp.inflater,
        input,
        expectedSize: cp.payloadSize,
        sourceEnded: input.length === remaining,
      }),
    );
    if (result.consumed + result.output.length === 0 && !result.done)
      return yield* failure(state.oid, "inflate");
    if (result.done && result.sourceOffset !== state.source.location.length - cp.headerLength)
      return yield* failure(state.oid, "range");
    const next = { ...cp, inflater: result.checkpoint, streamDone: result.done };
    return base === null
      ? yield* commit(state, next, result.output, result.done)
      : yield* commit(state, { ...next, pending: result.output });
  });

  return { initialize: initializePack, step: packStep };
});
