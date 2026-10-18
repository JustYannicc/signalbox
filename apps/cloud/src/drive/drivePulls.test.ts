// @effect-diagnostics nodeBuiltinImport:off - the test builds and uploads real git packs.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DriveDirectory } from "./DriveDirectory.ts";
import { MAIN_REF, threadRef, wipRef } from "./DriveStore.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";
import type {
  PullOperation,
  PullResult,
  PullSaveRequest,
} from "@signalbox/runner-protocol/PullProtocol";

const DRIVE = "my/personal/user_1";
const writer = (threadId: string, generation = 1, userId = "user_1") => ({
  threadId,
  userId,
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

const upload = (
  drives: ReturnType<typeof makeMemoryDrives>,
  packed: ReturnType<ReturnType<typeof makeRepo>["pack"]>,
  threadId = "t1",
) =>
  uploadPack({ driveId: DRIVE, threadId, idx: packed.idx, pack: packed.pack }).pipe(
    Effect.provide(drives.layer),
  );

const seeded = Effect.gen(function* () {
  const drives = makeMemoryDrives();
  const git = repo();
  git.write("base.txt", "base\n");
  const base = git.commit("base");
  yield* upload(drives, git.pack([base]));
  const handle = yield* DriveDirectory.use((directory) =>
    Effect.succeed(directory.forDrive(DRIVE)),
  ).pipe(Effect.provide(drives.layer));
  yield* handle.open(writer("seed"));
  yield* handle.updateRefs(writer("seed"), [{ name: threadRef("seed"), old: null, new: base }]);
  yield* handle.reconcile(writer("seed"), { expectedMain: null, newMain: base });
  yield* handle.open(writer("t1"));

  git.write("local.txt", "before pull\n");
  const dirty = git.commit("local work");
  yield* upload(drives, git.pack([dirty], [base]));
  yield* handle.updateRefs(writer("t1"), [{ name: wipRef("t1"), old: null, new: dirty }]);

  git.git(["checkout", "-q", "-b", "remote", base]);
  git.write("remote.txt", "upstream work\n");
  const target = git.commit("upstream work");
  git.git(["checkout", "-q", "work"]);
  git.git(["merge", "--no-ff", "-m", "pull", target]);
  const head = target;
  git.write("local.txt", "preserved after pull\n");
  const wip = git.commit("working tree after pull");
  yield* upload(drives, git.pack([wip], [base]));

  const operation: PullOperation = {
    id: "pull-1",
    target,
    expectedThread: base,
    expectedWip: dirty,
    revision: null,
    branch: "feature/example",
  };
  const result: PullResult = {
    id: operation.id,
    target,
    head,
    wip,
    outcome: "pulled",
    reason: null,
    hasWorkingTreeChanges: true,
  };
  const request: PullSaveRequest = { operation, result };
  return { drives, git, handle, base, dirty, target, head, wip, operation, result, request };
});

describe("drive pull receipts", () => {
  it.effect("saves the thread head separately from dirty WIP and recovers a lost completion", () =>
    Effect.gen(function* () {
      const { handle, base, dirty, head, wip, request } = yield* seeded;
      const saved = yield* handle.savePull(writer("t1"), request);
      expect(saved).toEqual(request.result);
      expect(yield* handle.ref(threadRef("t1"))).toBe(head);
      expect(yield* handle.ref(wipRef("t1"))).toBe(wip);
      expect(yield* handle.ref(MAIN_REF)).toBe(base);
      expect(yield* handle.pullReceipt(writer("t1"), request.operation.id)).toEqual(saved);
      expect(yield* handle.savePull(writer("t1"), request)).toEqual(saved);
      expect(yield* handle.ref(threadRef("t1"))).toBe(head);
      expect(yield* handle.ref(wipRef("t1"))).toBe(wip);
      expect(dirty).not.toBe(wip);
    }),
  );

  it.effect("keeps an up-to-date thread head while capturing an initial WIP snapshot", () =>
    Effect.gen(function* () {
      const { handle, base } = yield* seeded;
      yield* handle.open(writer("t2"));
      yield* handle.updateRefs(writer("t2"), [{ name: threadRef("t2"), old: null, new: base }]);
      const request: PullSaveRequest = {
        operation: {
          id: "up-to-date-initial",
          target: base,
          expectedThread: base,
          expectedWip: null,
          revision: null,
          branch: "feature/example",
        },
        result: {
          id: "up-to-date-initial",
          target: base,
          head: base,
          wip: base,
          outcome: "up_to_date",
          reason: null,
          hasWorkingTreeChanges: false,
        },
      };

      const saved = yield* handle.savePull(writer("t2"), request);
      expect(saved).toEqual(request.result);
      expect(yield* handle.ref(threadRef("t2"))).toBe(base);
      expect(yield* handle.ref(wipRef("t2"))).toBe(base);
    }),
  );

  it.effect("keeps an up-to-date thread head while updating the dirty WIP snapshot", () =>
    Effect.gen(function* () {
      const { handle, base, dirty, wip } = yield* seeded;
      const request: PullSaveRequest = {
        operation: {
          id: "up-to-date-dirty",
          target: base,
          expectedThread: base,
          expectedWip: dirty,
          revision: null,
          branch: "feature/example",
        },
        result: {
          id: "up-to-date-dirty",
          target: base,
          head: base,
          wip,
          outcome: "up_to_date",
          reason: null,
          hasWorkingTreeChanges: true,
        },
      };

      const saved = yield* handle.savePull(writer("t1"), request);
      expect(saved).toEqual(request.result);
      expect(yield* handle.ref(threadRef("t1"))).toBe(base);
      expect(yield* handle.ref(wipRef("t1"))).toBe(wip);
    }),
  );

  it.effect("refuses a pulled head that is not the selected target", () =>
    Effect.gen(function* () {
      const { handle, base, dirty, wip, request } = yield* seeded;
      const invalid: PullSaveRequest = {
        ...request,
        operation: { ...request.operation, id: "wrong-pulled-head" },
        result: { ...request.result, id: "wrong-pulled-head", head: wip },
      };

      const refused = yield* handle.savePull(writer("t1"), invalid);
      expect(refused).toMatchObject({
        outcome: "refused",
        reason: "The pull result does not match the selected target or current branch.",
      });
      expect(yield* handle.ref(threadRef("t1"))).toBe(base);
      expect(yield* handle.ref(wipRef("t1"))).toBe(dirty);
    }),
  );

  it.effect("refuses a reused id with a different payload and keeps its original receipt", () =>
    Effect.gen(function* () {
      const { handle, request } = yield* seeded;
      const saved = yield* handle.savePull(writer("t1"), request);
      const mismatched = {
        ...request,
        operation: { ...request.operation, branch: "feature/changed" },
      };
      const refused = yield* handle.savePull(writer("t1"), mismatched);
      expect(refused).toMatchObject({ outcome: "refused", id: request.operation.id });
      expect(yield* handle.pullReceipt(writer("t1"), request.operation.id)).toEqual(saved);
    }),
  );

  it.effect("records a stale revision as a refusal without moving either ref", () =>
    Effect.gen(function* () {
      const { handle, base, dirty, request } = yield* seeded;
      const changed = yield* handle.updateToLatest("user_1", {
        threadId: "t1",
        operationId: "latest-1",
        expectedThread: base,
        expectedWip: dirty,
        generation: 1,
      });
      expect(changed._tag).toBe("ok");
      const refused = yield* handle.savePull(writer("t1", 2), request);
      expect(refused).toMatchObject({
        outcome: "refused",
        reason: "The thread revision changed while pulling.",
      });
      expect(yield* handle.ref(threadRef("t1"))).toBe(base);
      expect(yield* handle.ref(wipRef("t1"))).toBe(dirty);
      expect(yield* handle.pullReceipt(writer("t1", 2), request.operation.id)).toEqual(refused);
    }),
  );

  it.effect("treats changed refs as a terminal CAS refusal and preserves the newer WIP", () =>
    Effect.gen(function* () {
      const { handle, base, dirty, wip, request } = yield* seeded;
      yield* handle.updateRefs(writer("t1"), [{ name: wipRef("t1"), old: dirty, new: wip }]);
      const refused = yield* handle.savePull(writer("t1"), request);
      expect(refused).toMatchObject({
        outcome: "refused",
        reason: "The thread's saved work changed while pulling.",
        head: base,
        wip,
      });
      expect(yield* handle.ref(threadRef("t1"))).toBe(base);
      expect(yield* handle.ref(wipRef("t1"))).toBe(wip);
      expect(yield* handle.pullReceipt(writer("t1"), request.operation.id)).toEqual(refused);
    }),
  );

  it.effect("rejects an older generation without writing a receipt", () =>
    Effect.gen(function* () {
      const { handle, request } = yield* seeded;
      yield* handle.open(writer("t1", 2));
      const refused = yield* handle.savePull(writer("t1", 1), request);
      expect(refused).toMatchObject({
        outcome: "refused",
        reason: "A newer machine of this thread writes here now.",
      });
      expect(yield* handle.pullReceipt(writer("t1", 2), request.operation.id)).toBeNull();
    }),
  );

  it.effect("refuses missing commits and revoked writers without moving refs", () =>
    Effect.gen(function* () {
      const { handle, base, dirty, request } = yield* seeded;
      const absent = "1111111111111111111111111111111111111111";
      const missing = {
        ...request,
        operation: { ...request.operation, id: "missing-commit", target: absent },
        result: {
          ...request.result,
          id: "missing-commit",
          target: absent,
          head: absent,
        },
      } satisfies PullSaveRequest;
      const missingResult = yield* handle.savePull(writer("t1"), missing);
      expect(missingResult).toMatchObject({
        outcome: "refused",
        reason: `The drive does not have commit ${absent}.`,
      });
      expect(yield* handle.ref(threadRef("t1"))).toBe(base);
      expect(yield* handle.ref(wipRef("t1"))).toBe(dirty);

      const revoked = yield* handle.savePull(writer("t1", 1, "other-user"), request);
      expect(revoked).toMatchObject({
        outcome: "refused",
        reason: "You no longer have access to change this drive.",
      });
      expect(
        yield* handle.pullReceipt(writer("t1", 1, "other-user"), request.operation.id),
      ).toBeNull();
      expect(yield* handle.pullReceipt(writer("t1"), request.operation.id)).toBeNull();
    }),
  );
});
