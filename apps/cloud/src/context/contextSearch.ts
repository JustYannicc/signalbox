import type { SearchHit, Searched } from "@signalbox/runner-protocol/ContextProtocol";
import { DRIVE_MERGE_MESSAGE } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { type DriveReader, makeDriveReader } from "../drive/DriveReader.ts";
import { MAIN_REF } from "../drive/DriveStore.ts";
import type { Oid } from "../drive/git/gitObjects.ts";
import type { ThreadObjectError } from "../thread/ThreadDirectory.ts";
import type { ContextReader } from "./ContextTool.ts";
import { isEvidence, matchTerms, queryTerms } from "./contextMatch.ts";

/** Drives whose history one search reads. */
const MAX_DRIVES = 25;
/** Commits of each drive's `main` one search reads, newest first. */
const MAX_COMMITS = 300;
/** Threads' unreconciled work per drive, most recently saved first. */
const MAX_WORK = 20;
/** Matching commits per drive whose changed files are listed. */
const MAX_COMMIT_HITS = 5;
const MAX_FILES = 40;
/** Matching drive hits one call returns. */
const MAX_DRIVE_HITS = 15;

export interface DriveHistorySearchResult {
  readonly hits: ReadonlyArray<SearchHit>;
  readonly searched: Searched;
  readonly truncated: boolean;
}

/** Search commit history and unsynced work. Thread content belongs to ThreadSearch. */
export const searchDriveHistory = Effect.fn("searchDriveHistory")(function* (input: {
  readonly reader: ContextReader;
  readonly query: string;
  /** Drives in scope, each currently readable by the person. */
  readonly driveIds: ReadonlyArray<string>;
  /** Checks a matching branch against the current thread row and owner scope. */
  readonly workVisible: (
    threadId: string,
    driveId: string,
  ) => Effect.Effect<boolean, ThreadObjectError>;
}) {
  const directory = yield* DriveDirectory;
  const terms = queryTerms(input.query);
  const searched: { -readonly [K in keyof Searched]: Searched[K] } = {
    threads: 0,
    threadsInScope: 0,
    drives: Math.min(input.driveIds.length, MAX_DRIVES),
    commits: 0,
    work: 0,
  };
  if (terms.length === 0) return { hits: [], searched, truncated: false };

  /** Paths that differ between two commits (null: nothing), up to `MAX_FILES`. */
  const changedFiles = (reader: DriveReader, from: Oid | null, to: Oid) =>
    Effect.gen(function* () {
      const changed = yield* reader.changes(yield* reader.treeOf(from), yield* reader.treeOf(to));
      return changed.map((file) => file.path);
    }).pipe(Effect.catchTags({ DriveReadError: () => Effect.succeed([]) }));

  const drives = input.driveIds.slice(0, MAX_DRIVES);
  const allHits = yield* Effect.forEach(
    drives,
    (driveId) =>
      Effect.gen(function* () {
        const handle = directory.forDrive(driveId);
        const reader = yield* makeDriveReader(driveId);
        const [main, unreconciled] = yield* Effect.all(
          [handle.ref(MAIN_REF), handle.unreconciled({ limit: MAX_WORK })],
          { concurrency: "unbounded" },
        );
        const history =
          main === null
            ? []
            : (yield* handle.log(main, MAX_COMMITS)).filter(
                (commit) => commit.message.trim() !== DRIVE_MERGE_MESSAGE,
              );
        searched.commits += history.length;
        const commitHits = yield* Effect.forEach(
          history
            .map((commit) => ({ commit, matched: matchTerms(terms, [commit.message]) }))
            .filter(({ matched }) => isEvidence(terms, matched))
            .slice(0, MAX_COMMIT_HITS),
          ({ commit, matched }) =>
            Effect.map(
              changedFiles(reader, commit.parents[0] ?? null, commit.oid),
              (files): SearchHit => ({
                kind: "commit",
                driveId,
                commit: commit.oid,
                parent: commit.parents[0] ?? null,
                message: commit.message.trim(),
                time: commit.time,
                matched,
                files: files.slice(0, MAX_FILES),
              }),
            ),
          { concurrency: 4 },
        );

        const work = unreconciled.filter((entry) => entry.threadId !== input.reader.threadId);
        searched.work += work.length;
        const workHits = yield* Effect.forEach(
          work,
          (entry) =>
            Effect.gen(function* () {
              const files = yield* changedFiles(reader, entry.base, entry.commit);
              const matched = matchTerms(terms, files);
              if (!isEvidence(terms, matched)) return [];
              if (!(yield* input.workVisible(entry.threadId, driveId))) return [];
              return [
                {
                  kind: "work",
                  driveId,
                  threadId: entry.threadId,
                  title: null,
                  commit: entry.commit,
                  base: entry.base,
                  matched,
                  files: files.slice(0, MAX_FILES),
                } satisfies SearchHit,
              ];
            }),
          { concurrency: 4 },
        );
        return [...commitHits, ...workHits.flat()];
      }),
    { concurrency: 4 },
  );

  const sorted = allHits
    .flat()
    .sort(
      (left, right) =>
        right.matched.length - left.matched.length || left.kind.localeCompare(right.kind),
    );
  return {
    hits: sorted.slice(0, MAX_DRIVE_HITS),
    searched,
    truncated: sorted.length > MAX_DRIVE_HITS,
  } satisfies DriveHistorySearchResult;
});
