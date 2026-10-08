import {
  DRIVE_COMMIT_AUTHOR,
  EMPTY_TREE,
  MAX_PACK_BYTES,
} from "@signalbox/runner-protocol/DriveProtocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DriveDirectory } from "./DriveDirectory.ts";
import { makeDriveReader, pathSegments } from "./DriveReader.ts";
import { MAIN_REF, type StoredCommit } from "./DriveStore.ts";
import { uploadPack } from "./DriveUploads.ts";
import { type Oid, parseTree } from "./git/gitObjects.ts";
import {
  encodeCommit,
  encodeTree,
  type WrittenObject,
  writePack,
  writtenObject,
} from "./git/gitWrite.ts";

/**
 * Splitting a folder out of a drive into a drive of its own, with its history,
 * so sharing the folder shares nothing else. Like `git subtree split`: each
 * commit that changed the folder becomes a commit of just the folder, with the
 * same author, time and message, so splitting the same history again gives
 * the same commits and a retry or a later split only fast-forwards. Then the
 * source drive gets a commit that removes the folder, and a shortcut to the
 * new drive at its path.
 *
 * Runs in the user's object, without a machine.
 */

export class DriveSplitError extends Schema.TaggedError<DriveSplitError>()("DriveSplitError", {
  message: Schema.String,
}) {}

/** Commits a split reads at most; a longer history is refused rather than cut. */
const MAX_SPLIT_COMMITS = 5_000;
/** Bytes of files a split copies at most, leaving room under the largest pack a drive stores. */
const MAX_SPLIT_BYTES = (MAX_PACK_BYTES * 3) / 4;
const ATTEMPTS = 3;
/** Objects read from the source at once: each is a drive object call and an R2 read. */
const READ_CONCURRENCY = 8;

const fail = (message: string) => Effect.fail(new DriveSplitError({ message }));

/** Parents before children, so each commit's parents are mapped before it. */
const topologicalOrder = (head: Oid, commits: ReadonlyMap<Oid, StoredCommit>) => {
  const order: Array<Oid> = [];
  const done = new Set<Oid>();
  const stack: Array<{ readonly oid: Oid; readonly expanded: boolean }> = [
    { oid: head, expanded: false },
  ];
  while (stack.length > 0) {
    const { oid, expanded } = stack.pop()!;
    if (done.has(oid)) continue;
    if (expanded) {
      done.add(oid);
      order.push(oid);
      continue;
    }
    stack.push({ oid, expanded: true });
    for (const parent of commits.get(oid)?.parents ?? []) {
      if (!done.has(parent) && commits.has(parent)) stack.push({ oid: parent, expanded: false });
    }
  }
  return order;
};

export const splitFolder = Effect.fn("DriveSplit.splitFolder")(function* (input: {
  readonly sourceId: string;
  readonly targetId: string;
  readonly path: string;
  /** Who is sharing: they must manage both drives. */
  readonly userId: string;
}) {
  const directory = yield* DriveDirectory;
  const source = directory.forDrive(input.sourceId);
  const target = directory.forDrive(input.targetId);
  const reader = yield* makeDriveReader(input.sourceId);
  const segments = pathSegments(input.path);
  if (segments === null || segments.length === 0) return yield* fail("Choose a folder to share.");
  const path = segments.join("/");

  /** The folder at a commit's root tree, or null where the commit has none. */
  const folderAt = (tree: Oid) =>
    Effect.map(reader.entryAt(tree, segments), (entry) =>
      entry?.kind === "directory" ? entry.oid : null,
    );

  /**
   * Every tree and file under `roots`, read from the source within the size
   * cap: a level of the trees at a time, each level's objects read at once.
   */
  const closure = (roots: Iterable<Oid>) =>
    Effect.gen(function* () {
      const objects: Array<WrittenObject> = [];
      const seen = new Set<Oid>(roots);
      let bytes = 0;
      let level = [...seen];
      while (level.length > 0) {
        const read = yield* Effect.forEach(
          level,
          (oid) => Effect.map(reader.object(oid), (object) => ({ oid, ...object })),
          { concurrency: READ_CONCURRENCY },
        );
        const next: Array<Oid> = [];
        for (const object of read) {
          bytes += object.content.length;
          objects.push(object);
          if (object.type !== "tree") continue;
          for (const entry of parseTree(object.content)) {
            if (entry.kind === "submodule" || seen.has(entry.oid)) continue;
            seen.add(entry.oid);
            next.push(entry.oid);
          }
        }
        if (bytes > MAX_SPLIT_BYTES) {
          return yield* fail("This folder is too big to share on its own yet.");
        }
        level = next;
      }
      return objects;
    });

  /** The folder's history as of `main`: its newest commit and every object it needs. */
  const splitHistory = (main: Oid) =>
    Effect.gen(function* () {
      const log = yield* reader.drive.log(main, MAX_SPLIT_COMMITS + 1);
      if (log.length > MAX_SPLIT_COMMITS) {
        return yield* fail("This drive has too much history to split a folder out of yet.");
      }
      const commits = new Map(log.map((commit) => [commit.oid, commit]));
      // Where the folder is in each commit doesn't depend on the mapping: look it up at once.
      const folders = new Map(
        yield* Effect.forEach(
          log,
          (commit) => Effect.map(folderAt(commit.tree), (folder) => [commit.oid, folder] as const),
          { concurrency: READ_CONCURRENCY },
        ),
      );
      const mapped = new Map<Oid, Oid | null>();
      const treeOf = new Map<Oid, Oid>();
      const created: Array<WrittenObject> = [];
      for (const oid of topologicalOrder(main, commits)) {
        const commit = commits.get(oid)!;
        const folder = folders.get(oid) ?? null;
        const parents = [
          ...new Set(
            commit.parents.map((parent) => mapped.get(parent) ?? null).filter((p) => p !== null),
          ),
        ];
        if (folder === null) {
          // No folder here: the split history carries on from where it was.
          mapped.set(oid, parents[0] ?? null);
        } else if (parents.length === 1 && treeOf.get(parents[0]!) === folder) {
          // The folder didn't change.
          mapped.set(oid, parents[0]!);
        } else {
          const written = yield* Effect.promise(() =>
            writtenObject(
              "commit",
              encodeCommit({
                tree: folder,
                parents,
                author: { name: commit.authorName, email: commit.authorEmail, time: commit.time },
                message: commit.message,
              }),
            ),
          );
          created.push(written);
          mapped.set(oid, written.oid);
          treeOf.set(written.oid, folder);
        }
      }
      const head = mapped.get(main) ?? null;
      if (head === null) return yield* fail(`There's no folder at ${path}.`);
      return { head, objects: [...created, ...(yield* closure(new Set(treeOf.values())))] };
    });

  /** `tree` without the folder; trees it leaves empty go too. */
  const without = (
    tree: Oid,
    rest: ReadonlyArray<string>,
    out: Array<WrittenObject>,
  ): Effect.Effect<Oid | null, Effect.Error<ReturnType<typeof reader.tree>>> =>
    Effect.gen(function* () {
      const [name, ...deeper] = rest;
      const entries = yield* reader.tree(tree);
      let next = entries.filter((entry) => entry.name !== name);
      if (deeper.length > 0) {
        const child = entries.find((entry) => entry.name === name && entry.kind === "directory");
        const replaced = child === undefined ? null : yield* without(child.oid, deeper, out);
        if (replaced !== null) {
          next = entries.map((entry) => (entry === child ? { ...entry, oid: replaced } : entry));
        }
      }
      if (next.length === 0) return null;
      const written = yield* Effect.promise(() => writtenObject("tree", encodeTree(next)));
      out.push(written);
      return written.oid;
    });

  /** Stores the objects `drive` doesn't have yet, as one pack. */
  const store = (driveId: string, objects: ReadonlyArray<WrittenObject>) =>
    Effect.gen(function* () {
      const drive = directory.forDrive(driveId);
      const absent = new Set(yield* drive.missing(objects.map((object) => object.oid)));
      const needed = objects.filter((object) => absent.has(object.oid));
      if (needed.length === 0) return;
      const packed = yield* Effect.promise(() => writePack(needed));
      const uploaded = yield* uploadPack({
        driveId,
        threadId: `share:${input.userId}`,
        idx: packed.idx,
        pack: packed.pack,
      });
      if (uploaded._tag === "refused") {
        yield* Effect.logError("split pack refused", { driveId, reason: uploaded.reason });
        return yield* fail("Sharing the folder failed. Try again.");
      }
    });

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const main = yield* source.ref(MAIN_REF);
    if (main === null) return yield* fail(`There's no folder at ${path}.`);
    const root = (yield* reader.commit(main)).tree;
    if ((yield* folderAt(root)) === null) return yield* fail(`There's no folder at ${path}.`);

    const split = yield* splitHistory(main);
    yield* store(input.targetId, split.objects);
    const targetMain = yield* target.ref(MAIN_REF);
    const started = yield* target.replaceMain(input.userId, {
      expectedMain: targetMain,
      newMain: split.head,
    });
    if (started._tag === "refused") return yield* fail(started.reason);
    if (started._tag === "conflict") continue;

    const trees: Array<WrittenObject> = [];
    const remaining = yield* without(root, segments, trees);
    if (remaining === null) {
      trees.push(yield* Effect.promise(() => writtenObject("tree", new Uint8Array())));
    }
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const removal = yield* Effect.promise(() =>
      writtenObject(
        "commit",
        encodeCommit({
          tree: remaining ?? EMPTY_TREE,
          parents: [main],
          author: { ...DRIVE_COMMIT_AUTHOR, time: now },
          message: `Share ${path} as its own drive\n`,
        }),
      ),
    );
    yield* store(input.sourceId, [...trees, removal]);
    const moved = yield* source.replaceMain(input.userId, {
      expectedMain: main,
      newMain: removal.oid,
      shortcut: { path, target: input.targetId },
    });
    if (moved._tag === "ok") return { head: split.head };
    if (moved._tag === "refused") return yield* fail(moved.reason);
    // `main` moved while splitting: split again, so the folder keeps those changes too.
  }
  return yield* fail("The drive kept changing while sharing the folder. Try again.");
});
