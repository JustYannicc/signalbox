import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { remoteCommitsWithoutInitialSeed } from "./driveRoutes.ts";
import { DriveDirectory } from "./DriveDirectory.ts";
import { threadRef } from "./DriveStore.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";

const DRIVE = "shared/personal/pr-seeds";
const USER = "user_1";
const REMOTE = { provider: "github", repository: "owner/repo", defaultBranch: "main" } as const;
const writer = (threadId: string, generation = 1) => ({
  threadId,
  userId: USER,
  generation,
  live: true,
  packsAfter: 0,
});

const repos: Array<ReturnType<typeof makeRepo>> = [];
const repo = () => {
  const created = makeRepo();
  repos.push(created);
  return created;
};
afterEach(() => {
  for (const created of repos.splice(0)) created.cleanup();
});

const setup = (role: "manager" | "viewer" = "manager") =>
  Effect.gen(function* () {
    const drives = makeMemoryDrives();
    const handle = yield* DriveDirectory.use((directory) =>
      Effect.succeed(directory.forDrive(DRIVE)),
    ).pipe(Effect.provide(drives.layer));
    yield* handle.setup({
      name: "Pull request seeds",
      members: [{ userId: USER, email: "owner@example.test", name: "Owner", role }],
    });
    yield* handle.setRemote(REMOTE);
    return { drives, handle };
  });

const request = (threadId: string, headSha: string) => ({
  operationId: `seed-${threadId}`,
  threadId,
  repository: REMOTE.repository,
  number: 42,
  headSha,
});

const upload = (
  drives: ReturnType<typeof makeMemoryDrives>,
  threadId: string,
  packed: ReturnType<ReturnType<typeof makeRepo>["pack"]>,
  remoteCommits: ReadonlyArray<string> = [],
) =>
  uploadPack({
    driveId: DRIVE,
    threadId,
    idx: packed.idx,
    pack: packed.pack,
    remoteCommits,
  }).pipe(Effect.provide(drives.layer));

describe("initial pull-request drive seeds", () => {
  it.effect(
    "replays the exact reservation and refuses a changed selection or a started thread",
    () =>
      Effect.gen(function* () {
        const { handle } = yield* setup();
        const selected = "a".repeat(40);
        const seed = request("new-thread", selected);

        expect(yield* handle.prepareThread(USER, seed)).toEqual({ _tag: "ok" });
        expect(yield* handle.prepareThread(USER, seed)).toEqual({ _tag: "ok" });
        expect((yield* handle.prepareThread(USER, { ...seed, headSha: "b".repeat(40) }))._tag).toBe(
          "refused",
        );

        const opened = yield* handle.open(writer(seed.threadId));
        expect(opened._tag).toBe("ok");
        if (opened._tag !== "ok") return;
        expect(opened.refs).toMatchObject({
          main: null,
          thread: null,
          base: null,
          pendingInitialRemoteHead: {
            repository: REMOTE.repository,
            number: 42,
            headSha: selected,
          },
        });
        expect(yield* handle.ref(threadRef(seed.threadId))).toBeNull();
        expect((yield* handle.prepareThread(USER, { ...seed, headSha: "c".repeat(40) }))._tag).toBe(
          "refused",
        );
      }),
  );

  it.effect("rechecks write access and the current remote before reserving", () =>
    Effect.gen(function* () {
      const { handle } = yield* setup("viewer");
      expect(
        (yield* handle.prepareThread(USER, request("viewer-thread", "a".repeat(40))))._tag,
      ).toBe("refused");
      expect(
        (yield* handle.prepareThread(USER, {
          ...request("other-repository", "a".repeat(40)),
          repository: "fork/repo",
        }))._tag,
      ).toBe("refused");

      yield* handle.open(writer("already-started"));
      expect(
        (yield* handle.prepareThread(USER, request("already-started", "a".repeat(40))))._tag,
      ).toBe("refused");
    }),
  );

  it.effect(
    "requires the exact known commit under the current writer generation, then keeps its base",
    () =>
      Effect.gen(function* () {
        const { drives, handle } = yield* setup();
        const git = repo();
        git.write("README.md", "base\n");
        const wrong = git.commit("base");
        git.write("README.md", "selected pull-request head\n");
        const selected = git.commit("selected head");
        const seed = request("new-thread", selected);
        yield* handle.prepareThread(USER, seed);
        yield* handle.open(writer(seed.threadId, 2));

        const stale = yield* handle.updateRefs(writer(seed.threadId, 1), [
          { name: threadRef(seed.threadId), old: null, new: selected },
        ]);
        expect(stale._tag).toBe("refused");

        const unknown = yield* handle.updateRefs(writer(seed.threadId, 2), [
          { name: threadRef(seed.threadId), old: null, new: selected },
        ]);
        expect(unknown._tag).toBe("refused");
        const wrongHead = yield* handle.updateRefs(writer(seed.threadId, 2), [
          { name: threadRef(seed.threadId), old: null, new: wrong },
        ]);
        expect(wrongHead._tag).toBe("refused");

        expect((yield* upload(drives, seed.threadId, git.pack([selected])))._tag).toBe("ok");
        const materialized = yield* handle.updateRefs(writer(seed.threadId, 2), [
          { name: threadRef(seed.threadId), old: null, new: selected },
        ]);
        expect(materialized._tag).toBe("ok");
        if (materialized._tag !== "ok") return;
        expect(materialized.refs).toMatchObject({
          thread: selected,
          base: selected,
          pendingInitialRemoteHead: null,
        });

        git.write("later.txt", "branch advanced\n");
        const later = git.commit("later");
        expect((yield* upload(drives, seed.threadId, git.pack([later], [selected])))._tag).toBe(
          "ok",
        );
        const advanced = yield* handle.updateRefs(writer(seed.threadId, 2), [
          { name: threadRef(seed.threadId), old: selected, new: later },
        ]);
        expect(advanced._tag).toBe("ok");
        if (advanced._tag !== "ok") return;
        expect(advanced.refs).toMatchObject({
          thread: later,
          base: selected,
          pendingInitialRemoteHead: null,
        });
        expect(yield* handle.prepareThread(USER, seed)).toEqual({ _tag: "ok" });
        expect(
          (yield* handle.prepareThread(USER, {
            ...seed,
            operationId: "other-seed",
            headSha: wrong,
          }))._tag,
        ).toBe("refused");
      }),
  );

  it.effect("authorizes only the exact pending fork head for the selected repository", () =>
    Effect.gen(function* () {
      const { drives, handle } = yield* setup();
      const git = repo();
      git.write("README.md", "fork pull-request head\n");
      const selected = git.commit("head from a fork");
      const another = "b".repeat(40);
      const seed = request("fork-thread", selected);
      yield* handle.prepareThread(USER, seed);
      const refs = yield* handle.refs(seed.threadId);
      const verify = remoteCommitsWithoutInitialSeed(REMOTE, refs.pendingInitialRemoteHead, [
        selected,
        another,
      ]);
      expect(verify).toEqual([another]);
      expect(
        remoteCommitsWithoutInitialSeed(null, refs.pendingInitialRemoteHead, [selected]),
      ).toEqual([selected]);

      // DriveUploads receives the original selected SHA after that exact SHA has
      // passed the seed check, so its one-deep parent and promised-tree rules still run.
      expect((yield* upload(drives, seed.threadId, git.pack([selected]), [selected]))._tag).toBe(
        "ok",
      );
      yield* handle.open(writer(seed.threadId));
      const consumed = yield* handle.updateRefs(writer(seed.threadId), [
        { name: threadRef(seed.threadId), old: null, new: selected },
      ]);
      expect(consumed._tag).toBe("ok");
      if (consumed._tag !== "ok") return;
      expect(
        remoteCommitsWithoutInitialSeed(REMOTE, consumed.refs.pendingInitialRemoteHead, [selected]),
      ).toEqual([selected]);
    }),
  );
});
