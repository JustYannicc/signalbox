// @effect-diagnostics nodeBuiltinImport:off - streaming SHA-1: WebCrypto only hashes whole buffers.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { DriveDirectory } from "./DriveDirectory.ts";
import { DrivePackError, DrivePacks } from "./DrivePacks.ts";
import { DriveReadError, makeDriveReader } from "./DriveReader.ts";
import type { ObjectLocation } from "./DriveStore.ts";
import { concatBytes, type Bytes, deflate, type ObjectType, type Oid } from "./git/gitObjects.ts";
import { readEntryHeader } from "./git/gitPack.ts";
import { entryHeader, fromHex, packHeader } from "./git/gitWrite.ts";

/**
 * The pack a push sends, streamed (#517): every object is copied as its
 * drive pack stores it, compressed bytes and all, from R2 to the remote, so
 * nothing is inflated, compressed again or held whole, whatever the push
 * adds. Its exact size is known before a byte is sent, so a host's limits are
 * checked first.
 *
 * A stored delta names its base by offset in its own pack, which means
 * nothing in another, so it goes as a `ref_delta`, naming its base by id. A
 * base the remote has is left out, as `git push` sends a thin pack; any other
 * base goes too.
 *
 * Objects go in the order their packs store them, so neighbouring small ones
 * are read from R2 in one request.
 */

/** Enough bytes for any entry header with its base reference. */
const HEADER_BYTES = 64;
/** Spans up to this size are read whole, a run of neighbours at once; bigger ones stream through. */
const HELD_SPAN_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 8;

interface Span {
  readonly pack: string;
  readonly offset: number;
  readonly length: number;
}

/** A stored object's whole entry in its pack, and how much of it is the header. */
interface StoredSpan extends Span {
  readonly headerLength: number;
}

export interface PushEntry {
  readonly oid: Oid;
  /** The object's own type, a delta's included. */
  readonly type: ObjectType;
  /** The object's inflated size. */
  readonly size: number;
  /** The entry's header in the pushed pack. */
  readonly header: Bytes;
  /** Its compressed bytes: what follows its stored entry's header, or held when no pack stores it. */
  readonly data: StoredSpan | Bytes;
}

const dataLength = ({ data }: PushEntry) =>
  data instanceof Uint8Array ? data.length : data.length - data.headerLength;

/** Bytes the pack of `entries` takes, with its header and checksum. */
export const packSize = (entries: ReadonlyArray<PushEntry>) =>
  entries.reduce((total, entry) => total + entry.header.length + dataLength(entry), 12 + 20);

const byPosition = (a: Span, b: Span) =>
  a.pack === b.pack ? a.offset - b.offset : a.pack < b.pack ? -1 : 1;

/** `spans`, in pack order, as runs of small neighbours read in one request each; a big span runs alone. */
const runsOf = <A extends Span>(spans: ReadonlyArray<A>) => {
  const runs: Array<{
    readonly pack: string;
    readonly offset: number;
    length: number;
    spans: Array<A>;
  }> = [];
  for (const span of spans) {
    const last = runs.at(-1);
    if (
      last !== undefined &&
      last.pack === span.pack &&
      last.offset + last.length === span.offset &&
      last.length + span.length <= HELD_SPAN_BYTES
    ) {
      last.length += span.length;
      last.spans.push(span);
    } else {
      runs.push({ pack: span.pack, offset: span.offset, length: span.length, spans: [span] });
    }
  }
  return runs;
};

/**
 * Where each of `objects` and every delta base they need are, in pack order.
 * Files the remote keeps for the drive (#406) are dropped: they are on the
 * remote already. Bases in `onRemote` are referred to, not sent. Of a stored
 * object only its header is read; one no pack stores (the empty tree) is
 * built here.
 */
export const planEntries = Effect.fn("pushPack.planEntries")(function* (
  driveId: string,
  objects: ReadonlyMap<Oid, ObjectType>,
  onRemote: ReadonlySet<Oid>,
) {
  const drive = (yield* DriveDirectory).forDrive(driveId);
  const packs = yield* DrivePacks;
  const reader = yield* makeDriveReader(driveId);
  const fail = (message: string) => new DriveReadError({ message });
  const typed = (oid: Oid, type: ObjectType) => {
    const expected = objects.get(oid);
    return expected === undefined || expected === type
      ? Effect.void
      : Effect.fail(fail(`${oid} is a ${type}, not a ${expected}.`));
  };
  const entries = new Map<Oid, PushEntry>();
  let wanted: ReadonlyArray<Oid> = [...objects.keys()];
  while (wanted.length > 0) {
    const located = [...(yield* drive.locate(wanted))].sort(byPosition);
    const stored = new Set(located.map((location) => location.oid));
    const unstored = wanted.filter((oid) => !stored.has(oid));
    const promised = new Set(
      unstored.length === 0 ? [] : (yield* drive.promised(unstored)).map((file) => file.oid),
    );
    for (const oid of unstored.filter((oid) => !promised.has(oid))) {
      const object = yield* reader.object(oid);
      yield* typed(oid, object.type);
      entries.set(oid, {
        oid,
        type: object.type,
        size: object.content.length,
        header: entryHeader(object.type, object.content.length),
        data: yield* Effect.promise(() => deflate(object.content)),
      });
    }
    // An offset delta's base is usually among these, which saves asking the drive.
    const at = new Map(located.map((found) => [`${found.pack}:${found.offset}`, found.oid]));
    const bases = new Set<Oid>();
    const plan = (location: ObjectLocation, bytes: Bytes, from: number) =>
      Effect.gen(function* () {
        yield* typed(location.oid, location.type);
        const header = yield* Effect.try({
          try: () => readEntryHeader(bytes, from),
          catch: () => fail(`Unreadable object ${location.oid}.`),
        });
        let base: Oid | null = header.kind === "ref_delta" ? header.baseOid! : null;
        if (header.kind === "ofs_delta") {
          const offset = location.offset - header.baseDistance!;
          base =
            at.get(`${location.pack}:${offset}`) ??
            (yield* drive.locateAt(location.pack, offset))?.oid ??
            null;
          if (base === null) return yield* fail(`The base of ${location.oid} is missing.`);
        }
        entries.set(location.oid, {
          oid: location.oid,
          type: location.type,
          size: location.size,
          header:
            base === null
              ? bytes.slice(from, from + header.headerLength)
              : concatBytes([entryHeader("ref_delta", header.size), fromHex(base)]),
          data: {
            pack: location.pack,
            offset: location.offset,
            length: location.length,
            headerLength: header.headerLength,
          },
        });
        if (base !== null && !objects.has(base) && !onRemote.has(base)) bases.add(base);
      });
    yield* Effect.forEach(
      runsOf(located),
      (run) =>
        Effect.gen(function* () {
          const bytes = yield* packs.range(
            driveId,
            run.pack,
            run.offset,
            run.length > HELD_SPAN_BYTES ? HEADER_BYTES : run.length,
          );
          for (const location of run.spans) {
            yield* plan(location, bytes, location.offset - run.offset);
          }
        }),
      { concurrency: READ_CONCURRENCY, discard: true },
    );
    wanted = [...bases].filter((oid) => !entries.has(oid));
  }
  const all = [...entries.values()];
  const held = all.filter((entry) => entry.data instanceof Uint8Array);
  const inPacks = all
    .flatMap((entry) => (entry.data instanceof Uint8Array ? [] : [{ entry, ...entry.data }]))
    .sort(byPosition)
    .map(({ entry }) => entry);
  return [...inPacks, ...held];
});

/**
 * The pack of `entries` (in `planEntries`' order), as a stream: the header,
 * each entry with its compressed bytes read from R2 as they go out, then the
 * checksum of it all. Runs of small neighbours are read a few at a time
 * ahead; a big one streams through.
 */
export const streamPack = Effect.fn("pushPack.streamPack")(function* (
  driveId: string,
  entries: ReadonlyArray<PushEntry>,
) {
  const packs = yield* DrivePacks;
  const held = entries.flatMap((entry) =>
    entry.data instanceof Uint8Array ? [entry.header, entry.data] : [],
  );
  const runs = runsOf(
    entries.flatMap((entry) =>
      entry.data instanceof Uint8Array ? [] : [{ entry, ...entry.data }],
    ),
  );
  type Run = (typeof runs)[number];
  const read = (
    run: Run,
  ): Effect.Effect<Stream.Stream<Uint8Array, DrivePackError>, DrivePackError> => {
    if (run.length <= HELD_SPAN_BYTES) {
      // Read now, ahead of its turn.
      return Effect.map(packs.range(driveId, run.pack, run.offset, run.length), (bytes) =>
        Stream.fromIterable(
          run.spans.flatMap(({ entry, offset, length, headerLength }) => [
            entry.header,
            bytes.subarray(offset - run.offset + headerLength, offset - run.offset + length),
          ]),
        ),
      );
    }
    // A big entry runs alone, and is only read when it's next.
    const { entry, offset, length, headerLength } = run.spans[0]!;
    const body = Stream.unwrap(
      Effect.map(
        packs.stream(driveId, run.pack, offset + headerLength, length - headerLength),
        (readable) =>
          Stream.fromReadableStream({
            evaluate: () => readable,
            onError: (cause) => new DrivePackError({ operation: "stream", cause }),
          }),
      ),
    );
    return Effect.succeed(Stream.concat(Stream.make(entry.header), body));
  };
  return Stream.suspend(() => {
    const hash = NodeCrypto.createHash("sha1");
    const stored = Stream.fromIterable(runs).pipe(
      Stream.mapEffect(read, { concurrency: READ_CONCURRENCY }),
      Stream.flatten(),
    );
    return Stream.make(packHeader(entries.length)).pipe(
      Stream.concat(stored),
      Stream.concat(Stream.fromIterable(held)),
      Stream.tap((bytes) => Effect.sync(() => hash.update(bytes))),
      Stream.concat(Stream.suspend(() => Stream.make(new Uint8Array(hash.digest())))),
    );
  });
});
