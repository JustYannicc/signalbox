import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import Pako from "pako/lib/zlib/inflate.js";
import ZStream from "pako/lib/zlib/zstream.js";
import { INFLATE_MAX_BYTES, InflateCheckpoint } from "./metadata/inflateState.ts";
import { restoreCheckpoint, saveCheckpoint } from "./metadata/pakoCheckpoint.ts";

export {
  INFLATE_MAX_BYTES,
  INFLATE_MAX_CHECKPOINT_BYTES,
  InflateCheckpoint,
} from "./metadata/inflateState.ts";

export class DriveInflateError extends Schema.TaggedError<DriveInflateError>()(
  "DriveInflateError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "invalid-checkpoint",
      "corrupt-stream",
      "truncated-input",
      "size-mismatch",
      "oversize-result",
      "inflater-failure",
    ]),
    sourceOffset: Schema.Number,
    expandedOffset: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const decodeCheckpoint = Schema.decodeUnknownEffect(InflateCheckpoint, {
  onExcessProperty: "error",
});
const validSize = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validLimit = (value: number) =>
  Number.isInteger(value) && value > 0 && value <= INFLATE_MAX_BYTES;

/**
 * Input starts at checkpoint.sourceOffset, relative to this zlib stream. The
 * caller binds checkpoints to an immutable source and commits output with the
 * checkpoint atomically. No input/output buffer or live inflater survives a call.
 */
export const inflateMetadataStep = (input: {
  readonly checkpoint: unknown;
  readonly input: Uint8Array;
  /** Git entry header's expanded payload size, including delta instructions. */
  readonly expectedSize: number;
  /** True when the supplied input includes the source's final byte. */
  readonly sourceEnded: boolean;
  readonly inputLimit?: number;
  readonly outputLimit?: number;
}) =>
  Effect.gen(function* () {
    const inputLimit = input.inputLimit ?? INFLATE_MAX_BYTES;
    const outputLimit = input.outputLimit ?? INFLATE_MAX_BYTES;
    if (!validSize(input.expectedSize) || !validLimit(inputLimit) || !validLimit(outputLimit)) {
      return yield* new DriveInflateError({
        reason: "invalid-input",
        sourceOffset: 0,
        expandedOffset: 0,
      });
    }
    const checkpoint =
      input.checkpoint === null
        ? null
        : yield* decodeCheckpoint(input.checkpoint).pipe(
            Effect.mapError(
              (cause) =>
                new DriveInflateError({
                  reason: "invalid-checkpoint",
                  sourceOffset: 0,
                  expandedOffset: 0,
                  cause,
                }),
            ),
          );
    const sourceOffset = checkpoint?.sourceOffset ?? 0;
    const expandedOffset = checkpoint?.expandedOffset ?? 0;
    const fail = (reason: DriveInflateError["reason"], cause?: unknown) =>
      new DriveInflateError({
        reason,
        sourceOffset,
        expandedOffset,
        ...(cause === undefined ? {} : { cause }),
      });
    if (checkpoint !== null && checkpoint.expectedSize !== input.expectedSize) {
      return yield* fail("invalid-checkpoint");
    }
    const stream = yield* Effect.try({
      try: () => {
        const stream = new ZStream();
        if (Pako.inflateInit2(stream, 15) !== 0) throw new Error("Inflater initialization failed");
        return stream;
      },
      catch: (cause) => fail("inflater-failure", cause),
    });
    if (checkpoint !== null)
      yield* Effect.try({
        try: () => restoreCheckpoint(stream, checkpoint),
        catch: (cause) => fail("invalid-checkpoint", cause),
      });
    const status = yield* Effect.try({
      try: () => {
        // A caller may pass a view of an entire pack; copy only the accepted slice.
        stream.input = new Uint8Array(input.input.subarray(0, inputLimit));
        stream.avail_in = stream.input.length;
        stream.output = new Uint8Array(outputLimit);
        stream.avail_out = outputLimit;
        return Pako.inflate(stream, 0); // Z_NO_FLUSH
      },
      catch: (cause) => fail("inflater-failure", cause),
    });
    if (status !== 0 && status !== 1 && status !== -5) return yield* fail("corrupt-stream");
    if (!validSize(stream.total_in) || !validSize(stream.total_out))
      return yield* fail("oversize-result");
    if (stream.total_out > input.expectedSize) return yield* fail("oversize-result");
    const done = status === 1; // Z_STREAM_END includes Adler checksum validation.
    if (done && stream.total_out !== input.expectedSize) return yield* fail("size-mismatch");
    if (
      !done &&
      input.sourceEnded &&
      stream.next_in === input.input.length &&
      stream.avail_out > 0
    ) {
      return yield* fail("truncated-input");
    }
    const nextCheckpoint = done
      ? null
      : yield* Effect.try({
          try: () => saveCheckpoint(stream, input.expectedSize),
          catch: (cause) => fail("inflater-failure", cause),
        }).pipe(
          Effect.flatMap((value) =>
            decodeCheckpoint(value).pipe(
              Effect.mapError((cause) => fail("inflater-failure", cause)),
            ),
          ),
        );
    return {
      output: stream.output!.slice(0, stream.next_out),
      checkpoint: nextCheckpoint,
      consumed: stream.next_in,
      sourceOffset: stream.total_in,
      expandedOffset: stream.total_out,
      done,
    };
  });
