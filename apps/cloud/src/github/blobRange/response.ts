import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

const MAX_RANGE_BYTES = 64 * 1024;
const RangeRequest = Schema.Struct({
  offset: Schema.Natural,
  length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RANGE_BYTES })),
});
export const isRangeRequest = Schema.is(RangeRequest);

const isByteOffset = Schema.is(Schema.Natural);

export interface BlobRange {
  readonly bytes: Uint8Array;
  readonly size: number | null;
  readonly complete: boolean;
}

class BlobRangeResponseError extends Schema.TaggedError<BlobRangeResponseError>()(
  "BlobRangeResponseError",
  {
    reason: Schema.Literals(["contentRange", "bodyLength", "bodyLimit"]),
  },
) {
  override get message(): string {
    return "GitHub sent an invalid blob range response.";
  }
}

const parsePartialRange = (header: string | undefined, offset: number, length: number) => {
  const match = header?.match(/^bytes ([0-9]+)-([0-9]+)\/([0-9]+|\*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const size = match[3] === "*" ? null : Number(match[3]);
  if (
    !isByteOffset(start) ||
    !isByteOffset(end) ||
    start !== offset ||
    end < start ||
    end - start >= length ||
    (size !== null && (!isByteOffset(size) || size <= end))
  ) {
    return null;
  }
  return { length: end - start + 1, size, complete: size !== null && end === size - 1 };
};

export const parseRangeEof = (header: string | undefined, offset: number) => {
  const match = header?.match(/^bytes \*\/([0-9]+)$/i);
  if (!match) return null;
  const size = Number(match[1]);
  return isByteOffset(size) && offset >= size ? size : null;
};

const readBoundedBytes = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  yield* response.stream.pipe(
    Stream.runForEach((chunk) => {
      if (chunk.byteLength > limit - length) {
        return Effect.fail(new BlobRangeResponseError({ reason: "bodyLimit" }));
      }
      length += chunk.byteLength;
      chunks.push(chunk);
      return Effect.void;
    }),
    Effect.catchIf(
      (error) => HttpClientError.isHttpClientError(error) && error.reason._tag === "EmptyBodyError",
      () => Effect.void,
    ),
  );
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});

export const readRange = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  offset: number,
  length: number,
): Effect.fn.Return<BlobRange, BlobRangeResponseError | HttpClientError.HttpClientError> {
  const range =
    response.status === 206
      ? parsePartialRange(response.headers["content-range"], offset, length)
      : null;
  if ((response.status === 206 && range === null) || (response.status === 200 && offset !== 0)) {
    return yield* new BlobRangeResponseError({ reason: "contentRange" });
  }
  const bytes = yield* readBoundedBytes(response, range?.length ?? length);
  if (range !== null && bytes.byteLength !== range.length) {
    return yield* new BlobRangeResponseError({ reason: "bodyLength" });
  }
  // A short 206 with an unknown total does not establish the representation's end.
  return {
    bytes,
    size: range === null ? bytes.byteLength : range.size,
    complete: range === null || range.complete,
  };
});
