import {
  PullRequestOperationError,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestDiffRevision,
  type PullRequestRef,
} from "@t3tools/contracts";
import { parseGitPatchHeaderPath } from "@t3tools/shared/gitPatchPath";
import * as Effect from "effect/Effect";

import type { PullRequestReadError } from "./CloudPullRequestsService.ts";

export interface PullRequestDiffFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
}

export interface PullRequestFileRevisionTarget {
  readonly repository: string;
  readonly token: string;
}

const MAX_DIFF_PAGES = 30;

const operationError = (detail: string, reason?: "conflict" | "invalid") =>
  new PullRequestOperationError({
    operation: "filesViewed",
    detail,
    ...(reason === undefined ? {} : { reason }),
  });

const sameRevision = (
  left: PullRequestDiffRevision | undefined,
  right: PullRequestDiffRevision | undefined,
) =>
  left !== undefined &&
  right !== undefined &&
  left.baseSha.toLowerCase() === right.baseSha.toLowerCase() &&
  left.headSha.toLowerCase() === right.headSha.toLowerCase();

export const samePullRequestDiffRevision = sameRevision;

const diffFile = (section: string): PullRequestDiffFile | null => {
  const lines = section.split("\n");
  const oldHeader = parseGitPatchHeaderPath(
    lines.find((line) => line.startsWith("--- ")),
    "a",
  );
  const newHeader = parseGitPatchHeaderPath(
    lines.find((line) => line.startsWith("+++ ")),
    "b",
  );
  if (oldHeader === null || newHeader === null) return null;

  const oldPath = oldHeader._tag === "Path" ? oldHeader.path : null;
  const newPath = newHeader._tag === "Path" ? newHeader.path : null;
  const path = newPath ?? oldPath;
  return path === null ? null : { path, oldPath, newPath };
};

/** Reads a complete, immutable PR diff and maps each changed path to its before/after sides. */
export const readPullRequestDiffFiles = (
  diff: (input: PullRequestDiffInput) => Effect.Effect<PullRequestDiffResult, PullRequestReadError>,
  reference: PullRequestRef,
): Effect.Effect<
  {
    readonly revision: PullRequestDiffRevision;
    readonly files: ReadonlyMap<string, PullRequestDiffFile>;
  },
  PullRequestReadError
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
        return yield* operationError("The current diff has no immutable revision.", "conflict");
      if (revision !== undefined && !sameRevision(revision, result.revision))
        return yield* operationError(
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
          return yield* operationError("A changed file path could not be verified.", "invalid");
        files.set(file.path, file);
      }

      if (result.nextCursor === null) return { revision: result.revision, files };
      if (seenCursors.has(result.nextCursor))
        return yield* operationError("The pull request diff did not advance.", "conflict");
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return yield* operationError("The pull request diff has too many pages.", "invalid");
  });
