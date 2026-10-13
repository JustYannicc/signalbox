import * as Effect from "effect/Effect";
import { EMPTY_TREE } from "@signalbox/runner-protocol/DriveProtocol";
import * as Schema from "effect/Schema";

import { DriveDirectory, type DriveObjectError } from "./DriveDirectory.ts";
import { type DrivePackError, DrivePacks } from "./DrivePacks.ts";
import { filePatch, MAX_DIFF_BYTES } from "./drivePatch.ts";
import type { ObjectLocation } from "./DriveStore.ts";
import {
  type Commit,
  inflate,
  type ObjectType,
  type Oid,
  parseCommit,
  parseTree,
  type TreeEntry,
} from "./git/gitObjects.ts";
import { applyDelta, readEntryHeader } from "./git/gitPack.ts";
import type { Bytes } from "./git/gitObjects.ts";

/**
 * Reading a drive without a machine: objects straight from their packs in R2
 * (one ranged read each, located through the drive's object index), and on
 * top of them directories, files and diffs between commits. Objects never
 * change, so they are cached by drive and id for the life of the isolate.
 */

export class DriveReadError extends Schema.TaggedError<DriveReadError>()("DriveReadError", {
  message: Schema.String,
}) {}

type ReadFailure = DriveReadError | DriveObjectError | DrivePackError;

interface GitObject {
  readonly type: ObjectType;
  readonly content: Bytes;
}

/** Most bytes of objects one isolate keeps in memory. */
const CACHE_BYTES = 16 * 1024 * 1024;
const cache = new Map<string, GitObject>();
let cachedBytes = 0;

const remember = (key: string, object: GitObject) => {
  if (object.content.length > CACHE_BYTES / 4) return;
  cache.set(key, object);
  cachedBytes += object.content.length;
  for (const [oldest, value] of cache) {
    if (cachedBytes <= CACHE_BYTES) break;
    cache.delete(oldest);
    cachedBytes -= value.content.length;
  }
};

const recall = (key: string) => {
  const object = cache.get(key);
  if (object !== undefined) {
    // Most recently used last.
    cache.delete(key);
    cache.set(key, object);
  }
  return object;
};

export { isWithin, pathSegments } from "@signalbox/runner-protocol/drivePaths";

export interface ChangedFile {
  readonly path: string;
  readonly before: TreeEntry | null;
  readonly after: TreeEntry | null;
}

export const makeDriveReader = Effect.fn("makeDriveReader")(function* (driveId: string) {
  const drive = (yield* DriveDirectory).forDrive(driveId);
  const packs = yield* DrivePacks;

  /** One object at its span of a pack, following delta bases within that pack. */
  const readAt = (location: ObjectLocation, depth = 0): Effect.Effect<GitObject, ReadFailure> =>
    Effect.gen(function* () {
      const fail = (message: string) => new DriveReadError({ message });
      if (depth > 64) return yield* fail("Delta chain too deep.");
      const bytes = yield* packs.range(driveId, location.pack, location.offset, location.length);
      const header = yield* Effect.try({
        try: () => readEntryHeader(bytes),
        catch: () => fail(`Unreadable object ${location.oid}.`),
      });
      const data = yield* Effect.tryPromise({
        try: () => inflate(bytes.subarray(header.headerLength)),
        catch: () => fail(`Unreadable object ${location.oid}.`),
      });
      if (header.kind !== "ofs_delta" && header.kind !== "ref_delta") {
        return { type: header.kind, content: data };
      }
      const base =
        header.kind === "ofs_delta"
          ? yield* drive.locateAt(location.pack, location.offset - header.baseDistance!)
          : ((yield* drive.locate([header.baseOid!]))[0] ?? null);
      if (base === null) return yield* fail(`The base of ${location.oid} is missing.`);
      const resolved = yield* readAt(base, depth + 1);
      return yield* Effect.try({
        try: () => ({ type: resolved.type, content: applyDelta(resolved.content, data) }),
        catch: () => fail(`Unreadable object ${location.oid}.`),
      });
    });

  const object = (oid: Oid): Effect.Effect<GitObject, ReadFailure> =>
    Effect.gen(function* () {
      const key = `${driveId}:${oid}`;
      const cached = recall(key);
      if (cached !== undefined) return cached;
      if (oid === EMPTY_TREE) return { type: "tree", content: new Uint8Array() } as const;
      const [location] = yield* drive.locate([oid]);
      if (location === undefined) {
        return yield* new DriveReadError({ message: `The drive has no object ${oid}.` });
      }
      const found = yield* readAt(location);
      remember(key, found);
      return found;
    });

  const typed = (oid: Oid, type: ObjectType) =>
    Effect.flatMap(object(oid), (found) =>
      found.type === type
        ? Effect.succeed(found.content)
        : Effect.fail(new DriveReadError({ message: `${oid} is a ${found.type}, not a ${type}.` })),
    );

  const commit = (oid: Oid): Effect.Effect<Commit, ReadFailure> =>
    Effect.map(typed(oid, "commit"), parseCommit);

  const tree = (oid: Oid) => Effect.map(typed(oid, "tree"), parseTree);

  /** The entry at `segments` under `root`, or null when there is none. */
  const entryAt = (root: Oid, segments: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      let entry: TreeEntry = { name: "", mode: "40000", kind: "directory", oid: root };
      for (const segment of segments) {
        if (entry.kind !== "directory") return null;
        const next = (yield* tree(entry.oid)).find((candidate) => candidate.name === segment);
        if (next === undefined) return null;
        entry = next;
      }
      return entry;
    });

  /** Every file under `root`, depth first, up to `limit`. */
  const files = (root: Oid, limit: number) =>
    Effect.gen(function* () {
      const out: Array<{ readonly path: string; readonly kind: "file" | "directory" }> = [];
      const walk = (oid: Oid, prefix: string): Effect.Effect<boolean, ReadFailure> =>
        Effect.gen(function* () {
          for (const entry of yield* tree(oid)) {
            if (out.length >= limit) return false;
            const path = `${prefix}${entry.name}`;
            if (entry.kind === "directory") {
              out.push({ path, kind: "directory" });
              if (!(yield* walk(entry.oid, `${path}/`))) return false;
            } else if (entry.kind !== "submodule") {
              out.push({ path, kind: "file" });
            }
          }
          return true;
        });
      const complete = yield* walk(root, "");
      return { entries: out, truncated: !complete };
    });

  /** Files that differ between two trees, by path. Renames show as a delete and an add. */
  const changes = (
    before: Oid,
    after: Oid,
    prefix = "",
  ): Effect.Effect<ReadonlyArray<ChangedFile>, ReadFailure> =>
    Effect.gen(function* () {
      if (before === after) return [];
      const left = new Map((yield* tree(before)).map((entry) => [entry.name, entry]));
      const right = new Map((yield* tree(after)).map((entry) => [entry.name, entry]));
      const names = [...new Set([...left.keys(), ...right.keys()])].sort();
      const out: Array<ChangedFile> = [];
      for (const name of names) {
        const a = left.get(name) ?? null;
        const b = right.get(name) ?? null;
        if (a !== null && b !== null && a.oid === b.oid && a.mode === b.mode) continue;
        const path = `${prefix}${name}`;
        const aDir = a?.kind === "directory";
        const bDir = b?.kind === "directory";
        if (aDir || bDir) {
          out.push(
            ...(yield* changes(aDir ? a!.oid : EMPTY_TREE, bDir ? b!.oid : EMPTY_TREE, `${path}/`)),
          );
        }
        const aFile = a !== null && !aDir && a.kind !== "submodule" ? a : null;
        const bFile = b !== null && !bDir && b.kind !== "submodule" ? b : null;
        if (aFile !== null || bFile !== null) out.push({ path, before: aFile, after: bFile });
      }
      return out;
    });

  /** The tree a commit points at; null stands for the empty drive. */
  const treeOf = (oid: Oid | null) =>
    oid === null ? Effect.succeed(EMPTY_TREE) : Effect.map(commit(oid), (found) => found.tree);

  /** A `git diff --patch` from commit `from` (null: nothing) to commit `to`. */
  const diff = (from: Oid | null, to: Oid, options: { readonly ignoreWhitespace: boolean }) =>
    Effect.gen(function* () {
      const changed = yield* changes(yield* treeOf(from), yield* treeOf(to));
      const blobs = changed.flatMap((file) =>
        [file.before, file.after].flatMap((entry) => (entry === null ? [] : [entry.oid])),
      );
      // A file too big to diff is never read: it shows as changed, without lines.
      const sizes = new Map(
        (blobs.length === 0 ? [] : yield* drive.locate(blobs)).map((found) => [
          found.oid,
          found.size,
        ]),
      );
      const side = (entry: TreeEntry | null, path: string) =>
        entry === null
          ? Effect.succeed(null)
          : Effect.map(
              (sizes.get(entry.oid) ?? 0) > MAX_DIFF_BYTES
                ? Effect.succeed(null)
                : typed(entry.oid, "blob"),
              (content) => ({
                path,
                mode: entry.mode === "100755" || entry.mode === "120000" ? entry.mode : "100644",
                oid: entry.oid,
                content,
              }),
            );
      const patches = yield* Effect.forEach(
        changed,
        (file) =>
          Effect.map(
            Effect.all([side(file.before, file.path), side(file.after, file.path)]),
            ([before, after]) => filePatch(before, after, options),
          ),
        { concurrency: 8 },
      );
      return patches.join("");
    });

  return { object, commit, tree, entryAt, files, changes, treeOf, diff, drive };
});

export type DriveReader = Effect.Success<ReturnType<typeof makeDriveReader>>;
