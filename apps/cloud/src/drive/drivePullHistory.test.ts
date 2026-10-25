// @effect-diagnostics nodeBuiltinImport:off - the test builds and reads real git packs.
import { expect, it } from "@effect/vitest";
import type { PullSaveRequest } from "@signalbox/runner-protocol/PullProtocol";
import * as Effect from "effect/Effect";

import { DriveDirectory } from "./DriveDirectory.ts";
import { makeDriveReader } from "./DriveReader.ts";
import { threadRef, wipRef } from "./DriveStore.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";

it.effect(
  "saves a pull over shared source packs with separate WIP and an immutable receipt",
  () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const git = yield* Effect.acquireRelease(Effect.sync(makeRepo), (repo) =>
        Effect.sync(() => repo.cleanup()),
      );
      const sourceId = "folder/org_test/source";
      const targetId = "folder/org_test/target";
      const directory = yield* DriveDirectory;
      const source = directory.forDrive(sourceId);
      const target = directory.forDrive(targetId);
      const member = {
        userId: "owner",
        email: "owner@example.com",
        name: "Owner",
        role: "owner",
      } as const;
      yield* source.setup({ name: "Source", members: [member] });
      yield* target.setup({ name: "Target", members: [member] });
      yield* source.setRemote({
        provider: "github",
        repository: "owner/repo",
        defaultBranch: "main",
      });
      git.write("base.txt", "base\n");
      const base = git.commit("base");
      git.write("local.txt", "keep this draft\n");
      const dirty = git.commit("dirty snapshot");
      git.git(["checkout", "-q", "-b", "remote", base]);
      git.write("remote.txt", "selected target\n");
      const selected = git.commit("remote target");
      git.write("local.txt", "keep this draft\n");
      const wip = git.commit("preserved working tree");
      const packed = git.pack([dirty, wip]);
      yield* uploadPack({ driveId: sourceId, threadId: "seed", ...packed });
      yield* source.replaceMain(member.userId, { expectedMain: null, newMain: base });
      const history = yield* source.history(member.userId);
      if (history._tag !== "ok") return expect.unreachable();
      expect((yield* target.startFromHistory(member.userId, history.history))._tag).toBe("ok");
      expect(yield* target.remote()).toMatchObject({ mode: "source" });
      const keys = drives.bucket.keys();
      const writer = {
        userId: member.userId,
        threadId: "pull-thread",
        generation: 1,
        live: true,
        packsAfter: 0,
      };
      yield* target.open(writer);
      yield* target.updateRefs(writer, [{ name: wipRef(writer.threadId), old: null, new: dirty }]);
      const request: PullSaveRequest = {
        operation: {
          id: "shared-history-pull",
          target: selected,
          expectedThread: base,
          expectedWip: dirty,
          revision: null,
          branch: "signalbox/pull-thread",
        },
        result: {
          id: "shared-history-pull",
          target: selected,
          head: selected,
          wip,
          outcome: "pulled",
          reason: null,
          hasWorkingTreeChanges: true,
        },
      };
      expect(yield* target.savePull(writer, request)).toEqual(request.result);
      expect(yield* target.pullReceipt(writer, request.operation.id)).toEqual(request.result);
      expect(yield* target.savePull(writer, request)).toEqual(request.result);
      expect(yield* target.ref(threadRef(writer.threadId))).toBe(selected);
      expect(yield* target.ref(wipRef(writer.threadId))).toBe(wip);
      expect(yield* target.ref("main")).toBe(base);
      expect(yield* source.ref("main")).toBe(base);
      expect(yield* source.ref(threadRef(writer.threadId))).toBeNull();
      expect(yield* target.packStorage(packed.name)).toBe(sourceId);
      expect(drives.bucket.keys()).toEqual(keys);
      const files = yield* makeDriveReader(targetId);
      const tree = (yield* files.commit(wip)).tree;
      const local = yield* files.entryAt(tree, ["local.txt"]);
      const remote = yield* files.entryAt(tree, ["remote.txt"]);
      expect(new TextDecoder().decode(yield* files.blob(local!.oid))).toBe("keep this draft\n");
      expect(new TextDecoder().decode(yield* files.blob(remote!.oid))).toBe("selected target\n");
    }).pipe(Effect.provide(drives.layer));
  },
);
