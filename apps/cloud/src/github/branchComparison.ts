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
 * head when that was pushed, else with the newest of the branch's commits it
 * has (pushed before, perhaps already merged) and the remote commits the
 * newer ones took in. When that can't be known, the comparison fails with
 * why rather than diffing against the wrong commit.
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
/** Most commits GitHub is asked about to find the newest of the branch's it has. */
const MAX_PROBES = 32;

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
 * The branch's history in the drive: each commit from `head` back to the
 * remote commits it sits on, with its parents. `complete` is false when the
 * walk ran long.
 */
const ownHistory = (drive: DriveHandle, head: Oid, shallow: ReadonlySet<Oid>) =>
  Effect.gen(function* () {
    const parentsOf = new Map<Oid, ReadonlyArray<Oid>>();
    const seen = new Set<Oid>();
    let next: ReadonlyArray<Oid> = [head];
    while (next.length > 0) {
      const wanted = next.filter((oid) => !seen.has(oid));
      for (const oid of wanted) seen.add(oid);
      if (seen.size > MAX_WALK) return { seen, parentsOf, complete: false };
      const found = yield* drive.commits(wanted);
      for (const commit of found) parentsOf.set(commit.oid, commit.parents);
      // A remote commit's parents stay on the remote: the walk stops there.
      next = found.filter((commit) => !shallow.has(commit.oid)).flatMap((commit) => commit.parents);
    }
    return { seen, parentsOf, complete: true };
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
          `This branch's history is too long to find where it left ${input.baseName}. Push it to compare on GitHub.`,
        );
      }
      // The newest commits of the branch GitHub has. It has every ancestor of a commit it
      // has, so along a line of single parents those are an unbroken oldest run, found by
      // halving; a merge splits the search into each of its parents.
      const shallow = new Set(input.shallow);
      const relations = new Map<Oid, RemoteRelation>();
      const newestKnown = new Set<Oid>();
      const unknown = new Set<Oid>([input.head]);
      const starts: Array<Oid> = [input.head];
      let probes = 0;
      const probe = (commit: Oid) =>
        Effect.gen(function* () {
          if (++probes > MAX_PROBES) {
            return yield* fail(
              `This branch has too much unpushed history to find where it left ${input.baseName}. Push it to compare on GitHub.`,
            );
          }
          const relation = yield* compare(input.base, commit);
          if (relation !== null) relations.set(commit, relation);
          return relation !== null;
        });
      while (starts.length > 0) {
        const start = starts.pop()!;
        const line = [start];
        for (;;) {
          const parents = history.parentsOf.get(line.at(-1)!) ?? [];
          const parent = parents[0];
          if (parents.length !== 1 || parent === undefined) break;
          if (shallow.has(line.at(-1)!) || shallow.has(parent)) break;
          if (!history.parentsOf.has(parent) || unknown.has(parent) || line.includes(parent)) break;
          line.push(parent);
        }
        // A remote commit GitHub has by definition; the head it just said it hasn't.
        let low = start === input.head ? 1 : 0;
        let high = line.length;
        if (shallow.has(start)) high = 0;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (yield* probe(line[middle]!)) high = middle;
          else low = middle + 1;
        }
        for (const commit of line.slice(0, low)) unknown.add(commit);
        if (low < line.length) {
          newestKnown.add(line[low]!);
          continue;
        }
        // GitHub has none of this line: where it goes on from is still to search.
        const last = line.at(-1)!;
        for (const parent of history.parentsOf.get(last) ?? []) {
          if (unknown.has(parent)) continue;
          if (shallow.has(parent)) newestKnown.add(parent);
          else if (history.parentsOf.has(parent)) starts.push(parent);
          else {
            return yield* fail(
              `Part of this branch's history isn't saved in this folder, so where it left ${input.baseName} is unknown.`,
            );
          }
        }
        if (!history.parentsOf.has(last) && !shallow.has(last)) {
          return yield* fail(
            `GitHub doesn't have ${short(last)}, which this branch is built on, so where it left ${input.baseName} is unknown.`,
          );
        }
      }
      if (newestKnown.size === 0) {
        return yield* fail(`This branch shares no history with ${input.baseName}.`);
      }
      if (newestKnown.size > MAX_FRONTIER) {
        return yield* fail(
          `This branch took in too many other commits to find where it left ${input.baseName}. Push it to compare on GitHub.`,
        );
      }
      const candidates = new Set<Oid>();
      for (const commit of newestKnown) {
        const relation = relations.get(commit) ?? (yield* compare(input.base, commit));
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
