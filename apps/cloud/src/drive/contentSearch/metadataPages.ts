import { EMPTY_TREE } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";

import { DriveReadError, type DriveReader } from "../DriveReader.ts";
import { beginTreePage, stepTreePage, type TreePagePosition } from "../DriveTreePage.ts";
import type { TreeEntry } from "../git/gitObjects.ts";

export type MetadataReader = Pick<DriveReader, "metadata" | "searchTreeOf" | "sizes">;
const CHUNK = 64 * 1024;
const FILE_LIMIT = 10 * 1024 * 1024;

/** Charges hydrated and cached reads alike; neither a warm isolate nor a huge tree removes a quota. */
export function metadataPages(reader: MetadataReader, entryLimit: number, byteLimit: number) {
  let work = 0;
  let bytes = 0;
  const cachedEntries = new Map<string, { entry: TreeEntry; next: TreePagePosition }>();
  const treeEnds = new Map<string, number>();
  const available = () => work < entryLimit && bytes < byteLimit;
  const consume = (length = 0) => {
    work++;
    bytes += length;
  };
  const ready = Effect.fn("ContentSearch.metadataReady")(function* (
    oid: string,
    maxSize?: number,
    kind?: "tree" | "blob",
  ) {
    if (oid === EMPTY_TREE) return "ready" as const;
    let state = yield* reader.metadata.status(oid);
    if (
      state !== null &&
      kind !== undefined &&
      (state.source.kind === "pack" ? state.source.location.type : "blob") !== kind
    )
      return yield* new DriveReadError({ message: "The search object has the wrong type." });
    const size = state?.source.kind === "pack" ? state.source.location.size : state?.source.size;
    if (maxSize !== undefined && (size ?? state?.bytesWritten ?? 0) > maxSize)
      return "oversized" as const;
    while (state === null || !state.complete) {
      if (!available() || byteLimit - bytes < CHUNK) return "pending" as const;
      const step = yield* reader.metadata.prepare(oid);
      consume(CHUNK);
      state = step.state;
      if (kind !== undefined && step.kind !== kind)
        return yield* new DriveReadError({ message: "The search object has the wrong type." });
      if (maxSize !== undefined && (step.size ?? state.bytesWritten) > maxSize)
        return "oversized" as const;
    }
    return "ready" as const;
  });
  const chunk = Effect.fn("ContentSearch.metadataChunk")(function* (
    oid: string,
    offset: number,
    kind: "blob" | "tree" = "blob",
  ) {
    if (!available() || (yield* ready(oid, undefined, kind)) !== "ready" || !available())
      return null;
    if (oid === EMPTY_TREE) return { bytes: new Uint8Array(), complete: true };
    const page = yield* reader.metadata.bytes(oid, offset, Math.min(CHUNK, byteLimit - bytes));
    if (page.bytes.length === 0 && page._tag !== "complete")
      return yield* new DriveReadError({ message: "Search metadata contains a gap." });
    consume(page.bytes.length);
    return { bytes: page.bytes, complete: page._tag === "complete" };
  });
  const entry = Effect.fn("ContentSearch.treeEntry")(function* (
    oid: string,
    position: TreePagePosition,
  ) {
    const key = `${oid}:${position.byteOffset}`;
    const cached = cachedEntries.get(key);
    if (cached !== undefined) {
      consume();
      return { entry: cached.entry, next: cached.next, done: false };
    }
    const page = yield* chunk(oid, position.byteOffset, "tree");
    if (page === null) return null;
    const parsed = yield* stepTreePage({ position, ...page, sourceEnded: page.complete }).pipe(
      Effect.mapError(
        (cause) => new DriveReadError({ message: "The search tree is invalid.", cause }),
      ),
    );
    if (parsed.done) treeEnds.set(oid, parsed.position.byteOffset);
    cachedEntries.clear();
    let start = position.byteOffset;
    for (let index = 0; index < parsed.entries.length; index++) {
      const next = { ...beginTreePage(), byteOffset: parsed.entryOffsets[index]! };
      cachedEntries.set(`${oid}:${start}`, { entry: parsed.entries[index]!, next });
      start = next.byteOffset;
    }
    const first = cachedEntries.get(key);
    return first === undefined
      ? { entry: null, next: parsed.position, done: parsed.done }
      : { ...first, done: false };
  });
  const blob = Effect.fn("ContentSearch.fileBytes")(function* (oid: string) {
    const size = (yield* reader.sizes([oid])).get(oid);
    if (size !== undefined && size !== null && size > FILE_LIMIT) return { kind: "skip" as const };
    const prepared = yield* ready(oid, FILE_LIMIT, "blob");
    if (prepared === "oversized") return { kind: "skip" as const };
    if (prepared !== "ready") return { kind: "defer" as const };
    const state = yield* reader.metadata.status(oid);
    if (state === null)
      return yield* new DriveReadError({ message: "Search metadata is missing." });
    if (state.bytesWritten > FILE_LIMIT || state.bytesWritten === 0)
      return { kind: "skip" as const };
    if (state.bytesWritten > byteLimit)
      return yield* new DriveReadError({ message: "The search byte budget cannot fit this file." });
    if (bytes + state.bytesWritten > byteLimit) return { kind: "defer" as const };
    const output = new Uint8Array(state.bytesWritten);
    let offset = 0;
    while (offset < output.length) {
      const page = yield* reader.metadata.bytes(
        oid,
        offset,
        Math.min(CHUNK, output.length - offset),
      );
      if (page.nextOffset <= offset)
        return yield* new DriveReadError({ message: "Search metadata contains a gap." });
      output.set(page.bytes, offset);
      offset = page.nextOffset;
    }
    consume(output.length);
    return { kind: "bytes" as const, bytes: output };
  });
  return {
    available,
    entry,
    chunk,
    blob,
    finished: (oid: string, position: TreePagePosition) =>
      treeEnds.get(oid) === position.byteOffset,
  };
}
