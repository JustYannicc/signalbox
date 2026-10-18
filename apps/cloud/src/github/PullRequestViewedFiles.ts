import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestDiffRevision,
  type PullRequestFilesViewedResult,
  type PullRequestInvalidateInput,
  type PullRequestRef,
  type PullRequestSetFilesViewedInput,
} from "@t3tools/contracts";
import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as UserDrives from "../user/UserDrives.ts";
import {
  PullRequestRepository,
  type ResolvedPullRequestRepository,
} from "./PullRequestRepository.ts";

export type PullRequestReadError = PullRequestUnavailableError | PullRequestOperationError;

export interface PullRequestDiffFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
}

export interface PullRequestFileRevisionTarget {
  readonly repository: string;
  readonly token: string;
}

export interface Dependencies {
  readonly invalidate: (input: PullRequestInvalidateInput) => Effect.Effect<void>;
  /** Must read GitHub directly, without the normal short-lived PR read cache. */
  readonly diff: (
    input: PullRequestDiffInput,
  ) => Effect.Effect<PullRequestDiffResult, PullRequestReadError>;
  /** Resolves the changed paths from the verified diff to immutable Git blob OIDs. */
  readonly fileRevisions: (
    target: PullRequestFileRevisionTarget,
    revision: PullRequestDiffRevision,
    files: ReadonlyArray<PullRequestDiffFile>,
  ) => Effect.Effect<ReadonlyMap<string, string>, PullRequestReadError>;
}

const MAX_FILES_VIEWED_ROWS = 500;
const MAX_DIFF_PAGES = 30;

const operationError = (
  operation: string,
  detail: string,
  reason?: "conflict" | "invalid" | "permission",
  cause?: unknown,
) =>
  new PullRequestOperationError({
    operation,
    detail,
    ...(reason ? { reason } : {}),
    ...(cause === undefined ? {} : { cause }),
  });

const sameRevision = (
  left: PullRequestDiffRevision | undefined,
  right: PullRequestDiffRevision | undefined,
) =>
  left !== undefined &&
  right !== undefined &&
  left.baseSha.toLowerCase() === right.baseSha.toLowerCase() &&
  left.headSha.toLowerCase() === right.headSha.toLowerCase();

const patchPath = (line: string | undefined, side: "a" | "b"): string | null => {
  if (line === undefined) return null;
  const token = line.slice(4).replace(/\r$/u, "");
  if (token === "/dev/null") return null;
  const unquoted = unquoteGitPatchPath(token);
  const prefix = `${side}/`;
  const path = unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
  return path.length === 0 ? null : path;
};

const diffFile = (section: string): PullRequestDiffFile | null => {
  const lines = section.split("\n");
  const oldPath = patchPath(
    lines.find((line) => line.startsWith("--- ")),
    "a",
  );
  const newPath = patchPath(
    lines.find((line) => line.startsWith("+++ ")),
    "b",
  );
  const path = newPath ?? oldPath;
  return path === null ? null : { path, oldPath, newPath };
};

const readDiffFiles = (
  diff: Dependencies["diff"],
  reference: PullRequestRef,
): Effect.Effect<
  {
    readonly revision: PullRequestDiffRevision;
    readonly files: ReadonlyMap<string, PullRequestDiffFile>;
  },
  PullRequestReadError | PullRequestOperationError
> =>
  Effect.gen(function* () {
    const files = new Map<string, PullRequestDiffFile>();
    let cursor: string | undefined;
    let revision: PullRequestDiffRevision | undefined;
    const seenCursors = new Set<string>();

    for (let page = 0; page < MAX_DIFF_PAGES; page += 1) {
      const input: PullRequestDiffInput = {
        ...reference,
        ...(cursor === undefined ? {} : { cursor }),
      };
      const result = yield* diff(input);
      if (result.revision === undefined)
        return yield* operationError(
          "filesViewed",
          "The current diff has no immutable revision.",
          "conflict",
        );
      if (revision !== undefined && !sameRevision(revision, result.revision))
        return yield* operationError(
          "filesViewed",
          "The pull request changed while its diff was being read. Try again.",
          "conflict",
        );
      revision = result.revision;

      const sections = result.patch
        .split(/(?=^diff --git )/mu)
        .filter((section) => section.startsWith("diff --git "));
      for (const section of sections) {
        const file = diffFile(section);
        if (file === null)
          return yield* operationError(
            "filesViewed",
            "A changed file path could not be verified.",
            "invalid",
          );
        files.set(file.path, file);
      }

      if (result.nextCursor === null) return { revision, files };
      if (seenCursors.has(result.nextCursor))
        return yield* operationError(
          "filesViewed",
          "The pull request diff did not advance.",
          "conflict",
        );
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return yield* operationError(
      "filesViewed",
      "The pull request diff has too many pages.",
      "invalid",
    );
  });

const storeError = (operation: string) => (cause: unknown) =>
  operationError(
    operation,
    "This environment could not reach its record of which files you have seen.",
    undefined,
    cause,
  );

export const makePullRequestViewedFiles = (dependencies: Dependencies) =>
  Effect.gen(function* () {
    const repositories = yield* PullRequestRepository;
    const drives = yield* UserDrives.UserDrives;
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS pull_request_files_viewed (
      account_id TEXT NOT NULL,
      viewer TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      path TEXT NOT NULL,
      revision TEXT NOT NULL,
      viewed_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, viewer, host, repository, number, path)
    )`;

    const scopeFor = (target: ResolvedPullRequestRepository, number: number) => ({
      accountId: target.accountId,
      viewer: target.viewer.toLowerCase(),
      host: target.host.toLowerCase(),
      repository: target.repository.toLowerCase(),
      number,
    });

    const referenceFor = (input: PullRequestRef, target: ResolvedPullRequestRepository) => ({
      projectId: input.projectId,
      host: target.host,
      expectedAccountId: target.accountId,
      repository: target.repository,
      number: input.number,
    });

    const fileRevisionTarget = (target: ResolvedPullRequestRepository) => ({
      repository: target.repository,
      token: target.token,
    });

    const resolve = (input: PullRequestRef) =>
      Effect.gen(function* () {
        const userId = yield* drives.userId.pipe(
          Effect.mapError((cause) =>
            operationError(
              "filesViewed",
              "The current person's access could not be verified.",
              "permission",
              cause,
            ),
          ),
        );
        if (userId === null)
          return yield* operationError(
            "filesViewed",
            "The current person could not be verified.",
            "permission",
          );
        return yield* repositories.resolve(input);
      });

    const filesViewed = (
      input: PullRequestRef,
    ): Effect.Effect<PullRequestFilesViewedResult, PullRequestReadError> =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const scope = scopeFor(target, input.number);
        const rows = yield* sql<{ readonly path: string; readonly revision: string }>`
          SELECT path, revision FROM pull_request_files_viewed
          WHERE account_id = ${scope.accountId} AND viewer = ${scope.viewer}
            AND host = ${scope.host} AND repository = ${scope.repository} AND number = ${scope.number}
          ORDER BY path LIMIT ${MAX_FILES_VIEWED_ROWS + 1}
        `.pipe(Effect.mapError(storeError("filesViewed")));
        const held = rows.slice(0, MAX_FILES_VIEWED_ROWS);
        if (held.length === 0) return { files: [], truncated: rows.length > MAX_FILES_VIEWED_ROWS };

        const current = yield* readDiffFiles(dependencies.diff, referenceFor(input, target));
        const filesToResolve = held.flatMap((mark) => {
          const file = current.files.get(mark.path);
          return file === undefined ? [] : [file];
        });
        const revisions =
          filesToResolve.length === 0
            ? new Map<string, string>()
            : yield* dependencies.fileRevisions(
                fileRevisionTarget(target),
                current.revision,
                filesToResolve,
              );
        return {
          files: held.map((mark) => ({
            path: mark.path,
            state:
              revisions.get(mark.path) === mark.revision
                ? ("viewed" as const)
                : ("dismissed" as const),
          })),
          truncated: rows.length > MAX_FILES_VIEWED_ROWS,
        };
      });

    const gates = new Map<string, { readonly gate: Semaphore.Semaphore; pending: number }>();
    const inOrder = <A, E>(key: string, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        const current = gates.get(key);
        const entry = current ?? { gate: Semaphore.makeUnsafe(1), pending: 0 };
        if (current === undefined) gates.set(key, entry);
        entry.pending += 1;
        return entry.gate
          .withPermits(1)(effect)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.pending -= 1;
                if (entry.pending === 0) gates.delete(key);
              }),
            ),
          );
      });

    const setFilesViewed = (
      input: PullRequestSetFilesViewedInput,
    ): Effect.Effect<void, PullRequestReadError> =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        if (input.files.length === 0) return;
        const scope = scopeFor(target, input.number);
        const reference = referenceFor(input, target);
        const writeKey = [
          scope.accountId,
          scope.viewer,
          scope.host,
          scope.repository,
          scope.number,
        ].join("\u0000");

        yield* inOrder(
          writeKey,
          Effect.gen(function* () {
            if (input.files.some((file) => file.viewed) && input.displayedRevision === undefined)
              return yield* operationError(
                "setFilesViewed",
                "Marking files requires the revision shown by the diff.",
                "invalid",
              );

            const marking = input.files.some((file) => file.viewed);
            const current = marking ? yield* readDiffFiles(dependencies.diff, reference) : null;
            if (
              current !== null &&
              input.displayedRevision !== undefined &&
              !sameRevision(input.displayedRevision, current.revision)
            )
              return yield* operationError(
                "setFilesViewed",
                "The pull request changed after this diff was shown. Refresh it and try again.",
                "conflict",
              );

            for (const file of input.files) {
              if (file.viewed && !current?.files.has(file.path))
                return yield* operationError(
                  "setFilesViewed",
                  "A file is not part of this pull request diff.",
                  "invalid",
                );
            }

            const viewedFiles = input.files.flatMap((file) => {
              const currentFile = current?.files.get(file.path);
              return file.viewed && currentFile !== undefined ? [currentFile] : [];
            });
            const revisions =
              viewedFiles.length === 0 || current === null
                ? new Map<string, string>()
                : yield* dependencies.fileRevisions(
                    fileRevisionTarget(target),
                    current.revision,
                    viewedFiles,
                  );
            for (const file of viewedFiles) {
              if (!revisions.has(file.path))
                return yield* operationError(
                  "setFilesViewed",
                  "GitHub did not provide an exact revision for a changed file.",
                  "conflict",
                );
            }

            const now = yield* Clock.currentTimeMillis;
            yield* resolve(reference);
            yield* sql
              .withTransaction(
                Effect.forEach(
                  input.files,
                  (file) =>
                    file.viewed
                      ? sql`
                        INSERT INTO pull_request_files_viewed
                          (account_id, viewer, host, repository, number, path, revision, viewed_at)
                        VALUES (
                          ${scope.accountId}, ${scope.viewer}, ${scope.host}, ${scope.repository},
                          ${scope.number}, ${file.path}, ${revisions.get(file.path)!}, ${now}
                        )
                        ON CONFLICT (account_id, viewer, host, repository, number, path)
                        DO UPDATE SET revision = excluded.revision, viewed_at = excluded.viewed_at
                      `
                      : sql`
                        DELETE FROM pull_request_files_viewed
                        WHERE account_id = ${scope.accountId} AND viewer = ${scope.viewer}
                          AND host = ${scope.host} AND repository = ${scope.repository}
                          AND number = ${scope.number} AND path = ${file.path}
                      `,
                  { discard: true },
                ),
              )
              .pipe(Effect.mapError(storeError("setFilesViewed")));

            yield* dependencies.invalidate({ reference });
          }),
        );
      });

    return { filesViewed, setFilesViewed } as const;
  });
