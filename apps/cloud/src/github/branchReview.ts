import type {
  ReviewDiffFileStat,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewSource,
  ReviewDiffRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DriveHandle } from "../drive/DriveDirectory.ts";
import type { ComparedFile, DriveFiles } from "../drive/DriveFiles.ts";
import { BranchComparisonError, gitHubCompare, mergeBase, type Oid } from "./branchComparison.ts";
import type { GitHubApi } from "./GitHubApi.ts";

/**
 * A thread's branch as the diff panel reviews it, from the drive with no
 * machine: `Changes` is its committed work against the branch it would merge
 * into (`git diff base...head`), and `Uncommitted` the latest save the branch
 * doesn't hold yet. Each source names the exact commits it compares
 * (`revision`), so a file's patch and contents read later match its stats.
 */

/** Past this, the preview's patch is cut and clients read files one at a time, as a self-hosted server does. */
const PATCH_LIMIT = 120_000;
/** One file's patch, read on its own. */
const FILE_PATCH_LIMIT = 1024 * 1024;
const TRUNCATED = "\n\n[truncated]";

export interface ReviewTarget {
  readonly driveId: string;
  readonly drive: DriveHandle;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly thread: { readonly id: string; readonly branch: string };
}

/** A branch as the base picker names it (`main`, `origin/main`), as GitHub names it. */
export const branchName = (ref: string) =>
  ref.replace(/^refs\/heads\//, "").replace(/^origin\//, "");

const sourceOf = (input: {
  readonly kind: ReviewDiffPreviewSource["kind"];
  readonly title: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly revision: ReviewDiffRevision | null;
  readonly files: ReadonlyArray<ComparedFile>;
  readonly ignoreWhitespace: boolean;
  readonly limit: number;
  /** The one file read, when only one was. */
  readonly path?: string;
}): ReviewDiffPreviewSource => {
  let diff = "";
  let truncated = false;
  for (const file of input.files) {
    if (diff.length + file.patch.length > input.limit) {
      truncated = true;
      break;
    }
    diff += file.patch;
  }
  const files = input.files.map((file): ReviewDiffFileStat => ({
    path: file.path,
    previousPath: null,
    additions: file.additions,
    deletions: file.deletions,
  }));
  const compared =
    input.revision === null ? "nothing" : `${input.revision.baseSha}...${input.revision.headSha}`;
  return {
    id: input.kind,
    kind: input.kind,
    title: input.title,
    baseRef: input.baseRef,
    headRef: input.headRef,
    diff: truncated ? `${diff}${TRUNCATED}` : diff,
    // What the source compares fixes its diff; a file read alone is kept apart from the whole.
    diffHash: `${compared}:${input.ignoreWhitespace ? "w" : "a"}${input.path === undefined ? "" : `:${input.path}`}`,
    truncated,
    files,
    ...(input.revision === null ? {} : { revision: input.revision }),
  };
};

/** Totals already counted, by drive and the commits compared. */
const counted = new Map<string, { readonly insertions: number; readonly deletions: number }>();

export const makeBranchReview = (deps: {
  readonly api: GitHubApi;
  readonly files: DriveFiles["Service"];
}) => {
  const fail = (message: string) => new BranchComparisonError({ message });

  /** Where the branch left `baseName` on GitHub, and its committed head; null head: nothing committed. */
  const comparison = (target: ReviewTarget, token: string, baseName: string) =>
    Effect.gen(function* () {
      const [base, refs] = yield* Effect.all(
        [
          deps.api
            .branchHead(token, target.repository, baseName)
            .pipe(Effect.mapError((error) => fail(error.message))),
          target.drive.refs(target.thread.id),
        ],
        { concurrency: 2 },
      );
      if (base === null) return yield* fail(`${baseName} isn't a branch on GitHub.`);
      if (refs.thread === null) return { refs, revision: null };
      const from = yield* mergeBase({
        driveId: target.driveId,
        drive: target.drive,
        head: refs.thread,
        base,
        baseName,
        shallow: refs.shallow,
        compare: gitHubCompare(deps.api, token, target.repository),
      });
      return { refs, revision: { baseSha: from, headSha: refs.thread } };
    });

  /** The branch's committed lines added and removed against `baseName`, for the git panel's status. */
  const totals = (target: ReviewTarget, token: string, baseName: string) =>
    Effect.gen(function* () {
      const { revision } = yield* comparison(target, token, baseName);
      if (revision === null) return { baseRef: baseName, insertions: 0, deletions: 0 };
      const key = `${target.driveId}:${revision.baseSha}:${revision.headSha}`;
      const known = counted.get(key);
      if (known !== undefined) return { baseRef: baseName, ...known };
      const changed = yield* deps.files.compare(
        target.driveId,
        revision.baseSha,
        revision.headSha,
        {
          ignoreWhitespace: false,
        },
      );
      const sums = {
        insertions: changed.reduce((sum, file) => sum + file.additions, 0),
        deletions: changed.reduce((sum, file) => sum + file.deletions, 0),
      };
      counted.set(key, sums);
      if (counted.size > 256) counted.delete(counted.keys().next().value!);
      return { baseRef: baseName, ...sums };
    });

  /**
   * The review sources for a thread's working tree. `defaultBase` is the
   * branch it would merge into when the request names none: its pull
   * request's base, else the folder's default branch.
   */
  const sources = (
    target: ReviewTarget,
    token: string,
    input: ReviewDiffPreviewInput,
    defaultBase: Effect.Effect<string, BranchComparisonError>,
  ) =>
    Effect.gen(function* () {
      const ignoreWhitespace = input.ignoreWhitespace ?? false;
      const file = input.file;
      const paths =
        file === undefined
          ? undefined
          : [file.path, ...(file.previousPath === null ? [] : [file.previousPath])];
      const limit = file === undefined ? PATCH_LIMIT : FILE_PATCH_LIMIT;
      const scope = { ignoreWhitespace, limit, ...(file === undefined ? {} : { path: file.path }) };
      const compare = (from: Oid, to: Oid) =>
        deps.files.compare(target.driveId, from, to, {
          ignoreWhitespace,
          ...(paths === undefined ? {} : { paths }),
        });
      const baseName = input.baseRef === undefined ? yield* defaultBase : branchName(input.baseRef);
      const changes = { title: `Changes vs ${baseName}`, baseRef: baseName };

      // One file of a source already shown: read at the commits it showed.
      if (file?.revision !== undefined) {
        const { baseSha, headSha } = file.revision;
        return [
          sourceOf({
            kind: file.sourceKind,
            ...(file.sourceKind === "branch-range"
              ? changes
              : { title: "Uncommitted", baseRef: target.thread.branch }),
            headRef: file.sourceKind === "branch-range" ? target.thread.branch : null,
            revision: file.revision,
            files: yield* compare(baseSha, headSha),
            ...scope,
          }),
        ];
      }

      const { refs, revision } = yield* comparison(target, token, baseName);
      const head = refs.thread;
      // A save the branch doesn't hold yet: the turn is still working on it.
      const saved = refs.wip !== null && refs.wip !== head ? refs.wip : null;
      const wip = head === null || saved === null ? null : { baseSha: head, headSha: saved };
      const [committed, uncommitted] = yield* Effect.all(
        [
          revision === null ? Effect.succeed([]) : compare(revision.baseSha, revision.headSha),
          wip === null ? Effect.succeed([]) : compare(wip.baseSha, wip.headSha),
        ],
        { concurrency: 2 },
      );
      const all = [
        sourceOf({
          kind: "working-tree",
          title: "Uncommitted",
          baseRef: target.thread.branch,
          headRef: null,
          revision: wip,
          files: uncommitted,
          ...scope,
        }),
        sourceOf({
          kind: "branch-range",
          ...changes,
          headRef: target.thread.branch,
          revision,
          files: committed,
          ...scope,
        }),
      ];
      return file === undefined ? all : all.filter((source) => source.kind === file.sourceKind);
    });

  return { totals, sources };
};
