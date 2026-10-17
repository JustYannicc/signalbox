import { describe, expect, it } from "@effect/vitest";
import { VcsListRefsResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { actor, current, fixture, root } from "./githubRefsTesting.ts";

const assertResult = Schema.decodeUnknownSync(VcsListRefsResult);

describe("cloud refs", () => {
  it.effect("uses the current branch recorded by the thread, including an unpublished branch", () =>
    Effect.gen(function* () {
      const { listRefs, state } = yield* fixture;
      state.threadBranch = "my-work";
      const result = yield* listRefs(actor, { cwd: current.path });
      expect(result.refs[0]).toEqual({
        name: "my-work",
        current: true,
        isRemote: false,
        isDefault: false,
        worktreePath: current.path,
      });
      expect(result.refs.some((ref) => ref.name === "origin/my-work")).toBe(false);
    }),
  );
  it.effect(
    "lists the current thread, mirrored default, and GitHub remote branches without a runner",
    () =>
      Effect.gen(function* () {
        const { listRefs, state } = yield* fixture;
        const result = assertResult(yield* listRefs(actor, { cwd: current.path }));
        expect(result).toEqual({
          refs: [
            {
              name: current.branch,
              isRemote: false,
              current: true,
              isDefault: false,
              worktreePath: current.path,
            },
            { name: "main", isRemote: false, current: false, isDefault: true, worktreePath: root },
            {
              name: "origin/feature/Alpha",
              isRemote: true,
              remoteName: "origin",
              current: false,
              isDefault: false,
              worktreePath: null,
            },
            {
              name: "origin/release",
              isRemote: true,
              remoteName: "origin",
              current: false,
              isDefault: false,
              worktreePath: null,
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          totalCount: 4,
          nextCursor: null,
        });
        expect(state.threadChecks).toBe(1);
        expect(state.requests.map((request) => request.url)).toEqual([
          "https://api.github.com/repos/owner/repository",
          "https://api.github.com/repos/owner/repository/git/matching-refs/heads/",
        ]);
        expect(state.requests.every((request) => request.token === "Bearer github-token")).toBe(
          true,
        );
      }),
  );

  it.effect(
    "marks the root's mirrored branch current and preserves both local and remote defaults when requested",
    () =>
      Effect.gen(function* () {
        const { listRefs } = yield* fixture;
        const result = yield* listRefs(actor, { cwd: root, includeMatchingRemoteRefs: true });
        expect(result.refs[0]).toMatchObject({ name: "main", current: true, isDefault: true });
        expect(result.refs[1]).toEqual({
          name: "origin/main",
          current: false,
          isDefault: true,
          isRemote: true,
          remoteName: "origin",
          worktreePath: null,
        });
        expect(result.refs.filter((ref) => ref.current)).toHaveLength(1);
      }),
  );

  it.effect(
    "filters case-insensitive substrings after ref kind and deduplication, then pages the matches",
    () =>
      Effect.gen(function* () {
        const { listRefs, state } = yield* fixture;
        state.branches = ["fix/Beta", "feature/alpha", "main", "fix/alpha", "feature/beta"];
        const first = yield* listRefs(actor, {
          cwd: root,
          query: "ALPHA",
          refKind: "remote",
          limit: 1,
        });
        expect(first.refs.map((ref) => ref.name)).toEqual(["origin/feature/alpha"]);
        expect(first.totalCount).toBe(2);
        expect(first.nextCursor).toBe(1);
        const second = yield* listRefs(actor, {
          cwd: root,
          query: "ALPHA",
          refKind: "remote",
          limit: 1,
          cursor: first.nextCursor!,
        });
        expect(second.refs.map((ref) => ref.name)).toEqual(["origin/fix/alpha"]);
        expect(second.nextCursor).toBe(null);
        expect(second.totalCount).toBe(2);
        const beyond = yield* listRefs(actor, { cwd: root, query: "alpha", cursor: 99 });
        expect(beyond).toMatchObject({ refs: [], nextCursor: null, totalCount: 2 });
      }),
  );

  it.effect("uses the same 100-ref default limit as GitCore", () =>
    Effect.gen(function* () {
      const { listRefs, state } = yield* fixture;
      state.branches = [
        "main",
        ...Array.from(
          { length: 124 },
          (_, index) => `feature-${index.toString().padStart(3, "0")}`,
        ),
      ];
      const first = yield* listRefs(actor, { cwd: root });
      expect(first.refs).toHaveLength(100);
      expect(first.totalCount).toBe(125);
      expect(first.nextCursor).toBe(100);
      const last = yield* listRefs(actor, { cwd: root, cursor: 100 });
      expect(last.refs).toHaveLength(25);
      expect(last.nextCursor).toBe(null);
      expect(new Set([...first.refs, ...last.refs].map((ref) => ref.name)).size).toBe(125);
    }),
  );

  it.effect("applies includeMatchingRemoteRefs before remote-only filtering like GitCore", () =>
    Effect.gen(function* () {
      const { listRefs } = yield* fixture;
      const deduped = yield* listRefs(actor, { cwd: current.path, refKind: "remote" });
      expect(deduped.refs.map((ref) => ref.name)).toEqual([
        "origin/feature/Alpha",
        "origin/release",
      ]);
      const all = yield* listRefs(actor, {
        cwd: current.path,
        refKind: "remote",
        includeMatchingRemoteRefs: true,
      });
      expect(all.refs.map((ref) => ref.name)).toEqual([
        "origin/main",
        "origin/feature/Alpha",
        "origin/release",
        `origin/${current.branch}`,
      ]);
      const local = yield* listRefs(actor, {
        cwd: current.path,
        refKind: "local",
        includeMatchingRemoteRefs: true,
      });
      expect(local.refs.map((ref) => ref.name)).toEqual([current.branch, "main"]);
    }),
  );

  it.effect("reads current GitHub defaults and refreshes branches on repeated calls", () =>
    Effect.gen(function* () {
      const { listRefs, state } = yield* fixture;
      yield* listRefs(actor, { cwd: root });
      state.defaultBranch = "trunk";
      state.branches = ["main", "trunk", "new-branch"];
      const result = yield* listRefs(actor, { cwd: root, refresh: true });
      expect(result.refs.map((ref) => ref.name)).toEqual([
        "main",
        "origin/trunk",
        "origin/new-branch",
      ]);
      expect(result.refs[0]?.isDefault).toBe(false);
      expect(result.refs[1]?.isDefault).toBe(true);
      expect(state.folderChecks).toBe(2);
      expect(state.requests).toHaveLength(4);
    }),
  );

  it.effect("handles missing local main, empty refs and unmatched searches", () =>
    Effect.gen(function* () {
      const { listRefs, state } = yield* fixture;
      state.main = null;
      const remote = yield* listRefs(actor, { cwd: root });
      expect(remote.refs[0]).toMatchObject({
        name: "origin/main",
        isDefault: true,
        current: false,
      });
      const unmatched = yield* listRefs(actor, { cwd: root, query: "missing" });
      expect(unmatched).toMatchObject({ refs: [], totalCount: 0, nextCursor: null, isRepo: true });
      state.branches = [];
      const empty = yield* listRefs(actor, { cwd: root });
      expect(empty).toMatchObject({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: true,
        totalCount: 0,
      });
    }),
  );

  it.effect("does not interpret host directories as repositories", () =>
    Effect.gen(function* () {
      const { listRefs, state, withoutDirectory } = yield* fixture;
      const empty = {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        totalCount: 0,
        nextCursor: null,
      };
      expect(yield* listRefs(actor, { cwd: "/tmp/host-repository" })).toEqual(empty);
      expect(yield* withoutDirectory(actor, { cwd: root })).toEqual(empty);
      expect(state.folderChecks).toBe(0);
      state.imported = false;
      expect(yield* listRefs(actor, { cwd: root })).toEqual(empty);
      expect(state.requests).toHaveLength(0);
    }),
  );
});
