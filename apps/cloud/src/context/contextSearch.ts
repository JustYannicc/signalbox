import type { SearchHit, SearchResult, Searched } from "@signalbox/runner-protocol/ContextProtocol";
import { DRIVE_MERGE_MESSAGE } from "@signalbox/runner-protocol/DriveProtocol";
import type { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { type DriveReader, makeDriveReader } from "../drive/DriveReader.ts";
import { MAIN_REF } from "../drive/DriveStore.ts";
import type { Oid } from "../drive/git/gitObjects.ts";
import { ThreadDirectory } from "../thread/ThreadDirectory.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { driveOfProject } from "../user/contextProjects.ts";
import { isEvidence, matchTerms, queryTerms, termsNeeded } from "./contextMatch.ts";
import type { ContextReader } from "./ContextTool.ts";

/**
 * The context tool's search: "in that drive we implemented X". Three kinds of
 * evidence, all limited to what the reader can see:
 *
 * - the reader's own threads (titles, the files their turns changed, and their
 *   full conversations, read in each thread's object);
 * - each readable drive's history on `main` (commit messages, which are the
 *   turns' prompts, and the files each matching commit changed);
 * - work other threads saved but haven't reconciled into `main` yet (the
 *   files it changes, and its thread's title when the reader can see it).
 *
 * Only candidates that hold enough of the query count (`contextMatch.ts`);
 * when none do, the answer is `insufficient_evidence`, with what was searched.
 * Every source is bounded, and the counts say how much was read.
 */

/** Threads whose conversations one search reads, most recently updated first. */
const MAX_THREADS = 40;
/** Drives whose history and unreconciled work one search reads. */
const MAX_DRIVES = 25;
/** Commits of each drive's `main` one search reads, newest first. */
const MAX_COMMITS = 300;
/** Threads' unreconciled work per drive, most recently saved first. */
const MAX_WORK = 20;
/** Matching commits per drive whose changed files are listed. */
const MAX_COMMIT_HITS = 5;
const MAX_FILES = 40;
const MAX_HITS = 15;

const KIND_ORDER: Record<SearchHit["kind"], number> = { thread: 0, work: 1, commit: 2 };

export const searchContext = Effect.fn("searchContext")(function* (input: {
  readonly reader: ContextReader;
  readonly actor: Actor;
  readonly query: string;
  /** Drives in scope, every one readable. */
  readonly driveIds: ReadonlyArray<string>;
  readonly shell: OrchestrationV2ShellSnapshot;
}) {
  const threads = yield* ThreadDirectory;
  const directory = yield* DriveDirectory;
  const terms = queryTerms(input.query);
  const searched: { -readonly [K in keyof Searched]: number } = {
    threads: 0,
    threadsInScope: 0,
    drives: 0,
    commits: 0,
    work: 0,
  };
  const none = (reason: string): SearchResult => ({
    _tag: "insufficient_evidence",
    terms,
    reason,
    searched,
  });
  if (terms.length === 0) {
    return none(
      "The query has no words to search for. Name what was done: the feature, a file, an error, a term from the conversation.",
    );
  }
  const inScope = new Set(input.driveIds);
  const userId = input.reader.userId;

  // The reader's own threads in scope, the current one aside: it holds the query itself.
  const titles = new Map<string, string>();
  const ownThreads = [...input.shell.threads, ...input.shell.archivedThreads]
    .filter((thread) => thread.id !== input.reader.threadId)
    .map((thread) => {
      titles.set(thread.id, thread.title);
      return { thread, driveId: driveOfProject(thread.projectId, userId) };
    })
    .filter(({ driveId }) => driveId !== null && inScope.has(driveId))
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(right.thread.updatedAt) -
        DateTime.toEpochMillis(left.thread.updatedAt),
    );
  searched.threadsInScope = ownThreads.length;

  const threadHits = Effect.forEach(
    ownThreads.slice(0, MAX_THREADS),
    ({ thread, driveId }) =>
      threads
        .forThread(thread.id)
        .contextMatch(input.actor, terms)
        .pipe(
          Effect.map((match) => {
            searched.threads++;
            return match === null || !isEvidence(terms, match.matched)
              ? []
              : [{ kind: "thread", threadId: thread.id, driveId, ...match } satisfies SearchHit];
          }),
          // One thread that can't answer leaves the rest of the search standing.
          Effect.catchTags({ ThreadObjectError: () => Effect.succeed([]) }),
        ),
    { concurrency: 8 },
  );

  const drives = input.driveIds.slice(0, MAX_DRIVES);
  searched.drives = drives.length;

  /** Paths that differ between two commits (null: nothing), up to `MAX_FILES`. */
  const changedFiles = (reader: DriveReader, from: Oid | null, to: Oid) =>
    Effect.gen(function* () {
      const changed = yield* reader.changes(yield* reader.treeOf(from), yield* reader.treeOf(to));
      return changed.map((file) => file.path);
    }).pipe(Effect.catchTags({ DriveReadError: () => Effect.succeed([]) }));

  const driveHits = Effect.forEach(
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

        const others = unreconciled.filter((work) => work.threadId !== input.reader.threadId);
        searched.work += others.length;
        const workHits = yield* Effect.forEach(
          others,
          (work) =>
            Effect.gen(function* () {
              const files = yield* changedFiles(reader, work.base, work.commit);
              const title = titles.get(work.threadId) ?? null;
              const matched = matchTerms(terms, [...files, ...(title === null ? [] : [title])]);
              if (!isEvidence(terms, matched)) return [];
              return [
                {
                  kind: "work",
                  driveId,
                  threadId: work.threadId,
                  title,
                  commit: work.commit,
                  base: work.base,
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

  const [fromThreads, fromDrives] = yield* Effect.all([threadHits, driveHits], {
    concurrency: "unbounded",
  });
  const hits = [...fromThreads.flat(), ...fromDrives.flat()]
    .sort(
      (left, right) =>
        right.matched.length - left.matched.length ||
        KIND_ORDER[left.kind] - KIND_ORDER[right.kind],
    )
    .slice(0, MAX_HITS);
  if (hits.length > 0) return { _tag: "found", terms, hits, searched } satisfies SearchResult;
  return none(
    `Nothing searched holds at least ${termsNeeded(terms)} of these words: ${terms.join(", ")}. ` +
      "This is not a guess that it doesn't exist: try other words for it (a file name, an error, " +
      "a term the conversation used), or name the drive it was done in.",
  );
});
