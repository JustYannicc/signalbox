import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DriveHandle } from "../drive/DriveDirectory.ts";
import type { GitHubApi } from "./GitHubApi.ts";

export type Oid = string;

/**
 * Where a thread's branch left the branch it is compared against: their merge
 * base, as `git diff base...head` uses it, so commits the base gained after
 * the branch forked never show as the branch's work.
 *
 * A remote-backed drive holds the remote's commits one deep, so the drive's
 * graph alone can't say how the base's head relates to the commits the branch
 * sits on. GitHub can, as the reader: it compares the base with the branch's
 * head when that was pushed, else with each remote commit the branch's own
 * history reaches. When neither answers, the comparison fails with why rather
 * than diffing against the wrong commit.
 */

export class BranchComparisonError extends Schema.TaggedError<BranchComparisonError>()(
  "BranchComparisonError",
  { message: Schema.String },
) {}

/** How `head` relates to `base` on the remote, or null when the remote doesn't know one of them. */
export type RemoteCompare = (
  base: Oid,
  head: Oid,
) => Effect.Effect<RemoteRelation | null, BranchComparisonError>;

export interface RemoteRelation {
  /** GitHub's word for `head` from `base`: `ahead` means `base` is an ancestor of `head`. */
  readonly status: "ahead" | "behind" | "identical" | "diverged";
  readonly mergeBase: Oid;
}

/** Most of a branch's own commits walked before giving up: past that its history is too long to trust. */
const MAX_WALK = 5_000;
/** Most remote commits a branch may sit on (its base, merges it took in) before giving up. */
const MAX_FRONTIER = 8;

const short = (oid: Oid) => oid.slice(0, 7);

const CompareBody = Schema.Struct({
  status: Schema.Literals(["ahead", "behind", "identical", "diverged"]),
  merge_base_commit: Schema.Struct({ sha: Schema.String }),
});
const decodeCompare = Schema.decodeUnknownOption(Schema.fromJsonString(CompareBody));
const FULL_SHA = /^[0-9a-f]{40}$/;

/** GitHub's compare of two commits in `repository`, as `token` reads it. */
export const gitHubCompare =
  (api: GitHubApi, token: string, repository: string): RemoteCompare =>
  (base, head) =>
    api
      // Page 2 of one commit leaves out the commit and file lists; only the relation is wanted.
      .rest("branchCompare", token, `/repos/${repository}/compare/${base}...${head}`, {
        per_page: "1",
        page: "2",
      })
      .pipe(
        // GitHub answers 404 for a commit it doesn't have, and 422 when it can't compare them.
        Effect.catchIf(
          (error) => error.status === 404 || error.status === 422,
          () => Effect.succeed(null),
        ),
        Effect.mapError(
          (error) =>
            new BranchComparisonError({ message: `GitHub couldn't compare: ${error.message}` }),
        ),
        Effect.flatMap((text) => {
          if (text === null) return Effect.succeed(null);
          const decoded = decodeCompare(text);
          if (decoded._tag === "None" || !FULL_SHA.test(decoded.value.merge_base_commit.sha)) {
            return Effect.fail(
              new BranchComparisonError({
                message: "GitHub sent a comparison Signalbox can't read.",
              }),
            );
          }
          return Effect.succeed({
            status: decoded.value.status,
            mergeBase: decoded.value.merge_base_commit.sha,
          });
        }),
      );

/**
 * The branch's own history in the drive, from `head` back to the remote
 * commits it sits on (`frontier`). `complete` is false when a commit's parent
 * is neither in the drive nor one of its remote commits, or the walk ran long.
 */
const ownHistory = (drive: DriveHandle, head: Oid, shallow: ReadonlySet<Oid>) =>
  Effect.gen(function* () {
    const seen = new Set<Oid>();
    const frontier = new Set<Oid>();
    let complete = true;
    let next: ReadonlyArray<Oid> = [head];
    while (next.length > 0) {
      const wanted = next.filter((oid) => !seen.has(oid));
      for (const oid of wanted) seen.add(oid);
      if (seen.size > MAX_WALK) return { seen, frontier, complete: false };
      const found = yield* drive.commits(wanted);
      if (found.length < wanted.length) complete = false;
      next = found.flatMap((commit) => {
        // A remote commit's parents stay on the remote: the walk stops there.
        if (shallow.has(commit.oid)) {
          frontier.add(commit.oid);
          return [];
        }
        return commit.parents;
      });
    }
    return { seen, frontier, complete };
  });

/** Merge bases already found, by drive, base and head: commits never change, so neither do they. */
const found = new Map<string, Oid>();
const remember = (key: string, oid: Oid) => {
  found.set(key, oid);
  if (found.size > 512) found.delete(found.keys().next().value!);
};

/**
 * The merge base of `base` and `head` (the base branch's head and the
 * thread's committed head) that the drive holds, so its files can be read.
 * `baseName` only words failures.
 */
export const mergeBase = (input: {
  readonly driveId: string;
  readonly drive: DriveHandle;
  readonly head: Oid;
  readonly base: Oid;
  readonly baseName: string;
  /** The drive's remote commits, kept without their parents. */
  readonly shallow: ReadonlyArray<Oid>;
  /** How the remote relates two commits; null for a drive without one. */
  readonly compare: RemoteCompare | null;
}) =>
  Effect.gen(function* () {
    const key = `${input.driveId}:${input.base}:${input.head}`;
    const cached = found.get(key);
    if (cached !== undefined) return cached;
    const fail = (message: string) => new BranchComparisonError({ message });
    const history = yield* ownHistory(input.drive, input.head, new Set(input.shallow));
    // The base is already on the branch: everything since it is the branch's.
    if (history.seen.has(input.base)) {
      remember(key, input.base);
      return input.base;
    }
    const resolved = yield* Effect.gen(function* () {
      if (input.compare === null) {
        return yield* fail(
          `This branch doesn't contain ${input.baseName}, and this folder has no remote to find where they split.`,
        );
      }
      const compare = input.compare;
      // A pushed head is compared directly: that also sees work the base already merged.
      const direct = yield* compare(input.base, input.head);
      if (direct !== null) return direct.mergeBase;
      if (!history.complete) {
        return yield* fail(
          `Part of this branch's history isn't saved in this folder, so where it left ${input.baseName} is unknown.`,
        );
      }
      const frontier = [...history.frontier];
      if (frontier.length === 0) {
        return yield* fail(`This branch shares no history with ${input.baseName}.`);
      }
      if (frontier.length > MAX_FRONTIER) {
        return yield* fail(
          `This branch took in too many other commits to find where it left ${input.baseName}. Push it to compare on GitHub.`,
        );
      }
      const candidates = new Set<Oid>();
      for (const commit of frontier) {
        const relation = yield* compare(input.base, commit);
        if (relation === null) {
          return yield* fail(
            `GitHub doesn't have ${short(commit)}, which this branch is built on, so where it left ${input.baseName} is unknown.`,
          );
        }
        candidates.add(relation.mergeBase);
      }
      // The best merge base is the one the others are ancestors of.
      let best: Oid | null = null;
      for (const candidate of candidates) {
        if (best === null) {
          best = candidate;
          continue;
        }
        const relation = yield* compare(best, candidate);
        if (relation === null || relation.status === "diverged") {
          return yield* fail(
            `This branch left ${input.baseName} at more than one point. Merge or rebase it onto ${input.baseName} to compare.`,
          );
        }
        if (relation.status === "ahead") best = candidate;
      }
      return best!;
    });
    if (!history.seen.has(resolved) && (yield* input.drive.commits([resolved])).length === 0) {
      return yield* fail(
        `This branch left ${input.baseName} at ${short(resolved)}, which this folder doesn't hold. Rebase the thread onto ${input.baseName} to compare.`,
      );
    }
    remember(key, resolved);
    return resolved;
  });
