import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DriveDirectory } from "./DriveDirectory.ts";
import { makeDriveReader } from "./DriveReader.ts";
import * as DrivePacks from "./DrivePacks.ts";
import { drivePackKey } from "./DrivePacks.ts";
import { MAIN_REF, machineRef, threadRef } from "./DriveStore.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";
import type { Oid } from "./git/gitObjects.ts";

const SOURCE = "folder/personal/fork-source";
const TARGET = "folder/personal/fork-target";
const NESTED = "folder/personal/fork-nested";
const BUSY = "folder/personal/fork-busy";
const REMOTE = { provider: "github", repository: "owner/repo", defaultBranch: "main" } as const;
const MANAGER = { userId: "manager", email: "manager@example.com", name: "Manager" } as const;
const VIEWER = { userId: "viewer", email: "viewer@example.com", name: "Viewer" } as const;

const repos: Array<ReturnType<typeof makeRepo>> = [];
const repo = () => {
  const created = makeRepo();
  repos.push(created);
  return created;
};
afterEach(() => {
  for (const created of repos.splice(0)) created.cleanup();
});

const drive = (drives: ReturnType<typeof makeMemoryDrives>, driveId: string) =>
  DriveDirectory.use((directory) => Effect.succeed(directory.forDrive(driveId))).pipe(
    Effect.provide(drives.layer),
  );

type Packed = ReturnType<ReturnType<typeof makeRepo>["pack"]>;
const upload = (
  drives: ReturnType<typeof makeMemoryDrives>,
  driveId: string,
  threadId: string,
  packed: Packed,
  options: {
    readonly remoteHead?: Oid;
    readonly promisedSizes?: Effect.Effect<ReadonlyMap<Oid, number>>;
    readonly private?: boolean;
  } = {},
) =>
  uploadPack({ driveId, threadId, idx: packed.idx, pack: packed.pack, ...options }).pipe(
    Effect.provide(drives.layer),
  );

const writer = (threadId: string, userId = MANAGER.userId) => ({
  threadId,
  userId,
  generation: 1,
  live: true,
  packsAfter: 0,
});

const person = (member: typeof MANAGER | typeof VIEWER, role: "manager" | "viewer") => ({
  ...member,
  role,
});

describe("drive forks", () => {
  it.effect("forks a viewer-visible main without copying private state or pack bytes", () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const git = repo();
      const readme = "from the remote\n";
      const app = "export const app = true;\n";
      const remoteFile = "still on GitHub\n";
      git.write("README.md", readme);
      const parent = git.commit("remote parent");
      git.write("app.ts", app);
      git.write("remote.md", remoteFile);
      const main = git.commit("remote main");
      const mainTree = git.git(["rev-parse", `${main}^{tree}`]) as Oid;
      const appBlob = git.git(["rev-parse", `${main}:app.ts`]) as Oid;
      const remoteBlob = git.git(["rev-parse", `${main}:remote.md`]) as Oid;
      const fileSizes = new Map<Oid, number>(
        git
          .git(["ls-tree", "-r", "--format=%(objectname) %(objectsize)", main])
          .split("\n")
          .map((line) => {
            const [oid, size] = line.split(" ");
            return [oid as Oid, Number(size)];
          }),
      );
      const bloblessMain = git.pack([main], [parent], "blob:none");
      const treeOnly = git.pack([mainTree], [], "blob:none");
      const appOnly = git.pack([appBlob]);

      const source = yield* drive(drives, SOURCE);
      yield* source.setup({ name: "Source", members: [person(MANAGER, "manager")] });
      yield* source.setRemote(REMOTE);
      expect(
        (yield* upload(drives, SOURCE, "seed", bloblessMain, {
          remoteHead: main as Oid,
          promisedSizes: Effect.succeed(fileSizes),
        }))._tag,
      ).toBe("ok");
      expect((yield* upload(drives, SOURCE, "seed", treeOnly))._tag).toBe("ok");
      expect((yield* upload(drives, SOURCE, "seed", appOnly))._tag).toBe("ok");
      expect(
        (yield* source.mirror(writer("seed"), { expectedMain: null, newMain: main as Oid }))._tag,
      ).toBe("ok");

      git.git(["checkout", "-q", "-b", "other-shallow", parent]);
      git.write("alternate.md", "another remote branch\n");
      const alternate = git.commit("alternate remote branch");
      const alternateFiles = new Map<Oid, number>(
        git
          .git(["ls-tree", "-r", "--format=%(objectname) %(objectsize)", alternate])
          .split("\n")
          .map((line) => {
            const [oid, size] = line.split(" ");
            return [oid as Oid, Number(size)];
          }),
      );
      const alternatePack = git.pack([alternate], [parent], "blob:none");
      expect(
        (yield* upload(drives, SOURCE, "alternate", alternatePack, {
          remoteHead: alternate as Oid,
          promisedSizes: Effect.succeed(alternateFiles),
        }))._tag,
      ).toBe("ok");

      git.git(["checkout", "-q", "-b", "unreconciled", main]);
      git.write("draft.md", "not on main\n");
      const unreconciled = git.commit("unreconciled work");
      const publicDraft = git.pack([unreconciled], [main]);
      expect((yield* upload(drives, SOURCE, "draft", publicDraft))._tag).toBe("ok");

      git.git(["checkout", "-q", "-b", "private", main]);
      git.write("private.txt", "private machine state\n");
      const privateHead = git.commit("private machine state");
      const privatePack = git.pack([privateHead], [main]);
      expect(
        (yield* upload(drives, SOURCE, "machine-thread", privatePack, { private: true }))._tag,
      ).toBe("ok");
      yield* source.open(writer("machine-thread"));
      expect(
        (yield* source.updateRefs(writer("machine-thread"), [
          { name: machineRef("machine-thread"), old: null, new: privateHead as Oid },
        ]))._tag,
      ).toBe("ok");
      expect(
        (yield* source.addShortcut(MANAGER.userId, {
          path: "Shared",
          target: "folder/personal/another-drive",
        }))._tag,
      ).toBe("ok");
      expect((yield* source.share(MANAGER, VIEWER, "viewer"))._tag).toBe("ok");

      const snapshot = yield* source.forkSnapshot(VIEWER.userId);
      expect(Object.keys(snapshot).toSorted()).toEqual(
        ["sourceDriveId", "main", "remote", "packs", "commits", "promised"].toSorted(),
      );
      expect(snapshot).toMatchObject({
        sourceDriveId: SOURCE,
        main,
        remote: { ...REMOTE, mode: "source" },
      });
      expect(snapshot.packs.map((pack) => pack.name)).toEqual([
        bloblessMain.name,
        treeOnly.name,
        appOnly.name,
        alternatePack.name,
        publicDraft.name,
      ]);
      expect(snapshot.packs.find((pack) => pack.name === treeOnly.name)?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tree" })]),
      );
      expect(snapshot.packs.find((pack) => pack.name === appOnly.name)?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ oid: appBlob, type: "blob" })]),
      );
      expect(snapshot.packs.find((pack) => pack.name === bloblessMain.name)?.shallow).toEqual([
        main,
      ]);
      expect(snapshot.packs.find((pack) => pack.name === alternatePack.name)?.shallow).toEqual([]);
      expect(snapshot.commits.map((commit) => commit.oid)).toEqual([main]);
      expect(snapshot.commits[0]?.parents).toEqual([parent]);
      expect(snapshot.packs.some((pack) => pack.name === privatePack.name)).toBe(false);

      const denied = yield* source.forkSnapshot("stranger").pipe(Effect.flip);
      expect(denied.cause).toMatchObject({ message: "You don't have access to this drive." });

      const target = yield* drive(drives, TARGET);
      yield* target.setup({ name: "Target", members: [person(MANAGER, "manager")] });
      expect(yield* target.startFrom(VIEWER.userId, snapshot)).toMatchObject({ _tag: "refused" });
      expect(yield* target.startFrom(MANAGER.userId, snapshot)).toEqual({ _tag: "ok" });
      expect(yield* target.startFrom(MANAGER.userId, snapshot)).toEqual({ _tag: "ok" });
      expect(
        yield* target.startFrom(MANAGER.userId, {
          ...snapshot,
          sourceDriveId: "folder/personal/other-source",
        }),
      ).toMatchObject({ _tag: "refused" });
      expect(yield* target.ref(MAIN_REF)).toBe(main);
      expect(yield* target.forkOrigin(MANAGER.userId)).toEqual({ driveId: SOURCE, main });
      expect((yield* target.members()).map((member) => member.userId)).toEqual([MANAGER.userId]);
      expect(yield* target.role(VIEWER.userId)).toBeNull();
      expect(yield* target.shortcuts()).toEqual([]);
      expect((yield* target.refs(null)).packs.map((pack) => pack.name)).toEqual(
        snapshot.packs.map((pack) => pack.name),
      );
      expect(yield* target.remote()).toEqual({ ...REMOTE, mode: "source" });
      expect(yield* target.log(main as Oid, 10)).toMatchObject([
        { oid: main, parents: [parent], message: "remote main\n" },
      ]);

      for (const pack of snapshot.packs) {
        expect(yield* target.packOrigin(pack.name)).toEqual({ driveId: SOURCE, name: pack.name });
        expect(drives.bucket.keys()).not.toContain(drivePackKey(TARGET, pack.name, "pack"));
      }

      const remoteReads: Array<Oid> = [];
      const reader = yield* makeDriveReader(TARGET, {
        blob: (oid) =>
          Effect.sync(() => {
            remoteReads.push(oid);
            return oid === remoteBlob ? new TextEncoder().encode(remoteFile) : null;
          }),
      });
      expect(new TextDecoder().decode(yield* reader.blob(appBlob))).toBe(app);
      expect(new TextDecoder().decode(yield* reader.blob(remoteBlob))).toBe(remoteFile);
      expect(remoteReads).toEqual([remoteBlob]);

      const packs = yield* DrivePacks.DrivePacks;
      const origin = yield* target.packOrigin(treeOnly.name);
      const stored = yield* packs.get(origin!.driveId, origin!.name, "pack");
      expect(stored).not.toBeNull();
      expect(
        new Uint8Array(yield* Effect.promise(() => new Response(stored!.body).arrayBuffer())),
      ).toEqual(treeOnly.pack);

      const nested = yield* drive(drives, NESTED);
      yield* nested.setup({ name: "Nested", members: [person(MANAGER, "manager")] });
      const nestedSnapshot = yield* target.forkSnapshot(MANAGER.userId);
      expect(yield* nested.startFrom(MANAGER.userId, nestedSnapshot)).toEqual({ _tag: "ok" });
      expect(yield* nested.packOrigin(treeOnly.name)).toEqual({
        driveId: SOURCE,
        name: treeOnly.name,
      });
      expect(drives.bucket.keys()).not.toContain(drivePackKey(NESTED, treeOnly.name, "pack"));

      const busy = yield* drive(drives, BUSY);
      yield* busy.setup({ name: "Busy", members: [person(MANAGER, "manager")] });
      yield* busy.addShortcut(MANAGER.userId, {
        path: "Already here",
        target: "folder/personal/another-drive",
      });
      expect(yield* busy.startFrom(MANAGER.userId, snapshot)).toMatchObject({
        _tag: "refused",
        reason: "This drive already has files or history.",
      });

      git.git(["checkout", "-q", "-b", "local-work", main]);
      git.write("local.txt", "kept in Signalbox\n");
      const localMain = git.commit("local work");
      expect(
        (yield* upload(drives, TARGET, "local-thread", git.pack([localMain], [main])))._tag,
      ).toBe("ok");
      const localWriter = writer("local-thread");
      expect((yield* target.open(localWriter))._tag).toBe("ok");
      expect(
        (yield* target.updateRefs(localWriter, [
          { name: threadRef(localWriter.threadId), old: main, new: localMain as Oid },
        ]))._tag,
      ).toBe("ok");
      expect(
        yield* target.mirror(localWriter, { expectedMain: main, newMain: localMain as Oid }),
      ).toMatchObject({ _tag: "refused" });
      expect(
        yield* target.reconcile(localWriter, { expectedMain: main, newMain: localMain as Oid }),
      ).toMatchObject({ _tag: "ok", refs: { main: localMain } });
    }).pipe(Effect.provide(drives.layer));
  });

  it.effect("keeps public packs when the source has no main ref", () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const git = repo();
      git.write("draft.md", "no main yet\n");
      const draft = git.commit("draft");
      const packed = git.pack([draft]);
      const source = yield* drive(drives, SOURCE);
      yield* source.setup({ name: "Source", members: [person(MANAGER, "manager")] });
      expect((yield* upload(drives, SOURCE, "draft", packed))._tag).toBe("ok");

      const snapshot = yield* source.forkSnapshot(MANAGER.userId);
      expect(snapshot.main).toBeNull();
      expect(snapshot.packs.map((pack) => pack.name)).toEqual([packed.name]);
      expect(snapshot.commits).toEqual([]);

      const target = yield* drive(drives, TARGET);
      yield* target.setup({ name: "Target", members: [person(MANAGER, "manager")] });
      expect(yield* target.startFrom(MANAGER.userId, snapshot)).toEqual({ _tag: "ok" });
      expect(yield* target.ref(MAIN_REF)).toBeNull();
      expect((yield* target.refs(null)).packs.map((pack) => pack.name)).toEqual([packed.name]);
    }).pipe(Effect.provide(drives.layer));
  });
});
