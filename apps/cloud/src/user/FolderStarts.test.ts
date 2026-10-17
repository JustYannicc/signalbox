import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { makeRepo } from "../drive/driveTesting.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import { makeDriveReader } from "../drive/DriveReader.ts";
import { MAIN_REF } from "../drive/DriveStore.ts";
import { DriveSharing } from "./DriveSharing.ts";
import * as Effect from "effect/Effect";

import { makeMemoryCloud } from "../testing.ts";
import { FolderStarts } from "./FolderStarts.ts";
import { UserFolders } from "./UserFolders.ts";

const USER = "user_alice";
const ACME = SignalboxContextId.make("org_acme");
const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const user = cloud.userDirectory.forUser(USER);
  yield* user.recordSignIn({ id: USER, email: "alice@example.test" });
  yield* user.syncOrganizations([{ id: ACME, name: "Acme" }]);
  return cloud;
});

describe("starting a folder from another", () => {
  it.effect(
    "lets a reader share the fixed history without copying bytes, and isolates later work",
    () =>
      Effect.gen(function* () {
        const cloud = makeMemoryCloud({
          people: [
            { userId: USER, email: "alice@example.test", name: "Alice", organizations: [ACME] },
            { userId: "user_bob", email: "bob@example.test", name: "Bob", organizations: [ACME] },
          ],
        });
        for (const [id, email] of [
          [USER, "alice@example.test"],
          ["user_bob", "bob@example.test"],
        ]) {
          yield* cloud.userDirectory.forUser(id!).recordSignIn({ id: id!, email: email! });
          yield* cloud.userDirectory.forUser(id!).syncOrganizations([{ id: ACME, name: "Acme" }]);
        }
        const repo = yield* Effect.acquireRelease(Effect.sync(makeRepo), (repo) =>
          Effect.sync(repo.cleanup),
        );
        repo.write("idea.md", "Original idea\n");
        const head = repo.commit("Start the idea");
        const drive = yield* DriveSharing.use((sharing) =>
          sharing.create({ contextId: ACME, name: "Original files" }),
        ).pipe(Effect.provide(cloud.layerFor(USER)));
        yield* Effect.gen(function* () {
          const directory = yield* DriveDirectory;
          const original = directory.forDrive(drive.id);
          const packed = repo.pack([head]);
          expect((yield* uploadPack({ driveId: drive.id, threadId: "seed", ...packed }))._tag).toBe(
            "ok",
          );
          expect(
            (yield* original.replaceMain(USER, { expectedMain: null, newMain: head }))._tag,
          ).toBe("ok");
          const sharing = yield* DriveSharing;
          yield* sharing.share({ driveId: drive.id, email: "bob@example.test", role: "viewer" });
        }).pipe(Effect.provide(cloud.layerFor(USER)));
        const before = cloud.drives.bucket.keys();
        const result = yield* Effect.gen(function* () {
          const folders = yield* UserFolders;
          const source = (yield* folders.snapshot).folders.find(
            (folder) => folder.files?.projectId === drive.projectId,
          )!;
          return yield* FolderStarts.use((starts) =>
            starts.startFrom({ id: source.id, newFolderId: FolderId.make("bobs-idea") }),
          );
        }).pipe(Effect.provide(cloud.layerFor("user_bob")));
        const fork = result.folders.find((folder) => folder.id === "bobs-idea")!;
        expect(fork.ownerId).toBe(ACME);
        expect(fork.origin?.commit).toBe(head);
        expect(
          result.folders.filter((folder) => folder.origin?.folderId === fork.origin?.folderId),
        ).toHaveLength(1);
        const retried = yield* FolderStarts.use((starts) =>
          starts.startFrom({ id: fork.origin!.folderId, newFolderId: fork.id }),
        ).pipe(Effect.provide(cloud.layerFor("user_bob")));
        expect(retried.folders.find((folder) => folder.id === fork.id)).toEqual(fork);
        expect(cloud.drives.bucket.keys()).toEqual(before);
        yield* DriveSharing.use((sharing) =>
          sharing.unshare({ driveId: drive.id, userId: "user_bob" }),
        ).pipe(Effect.provide(cloud.layerFor(USER)));
        expect(
          (yield* UserFolders.use((folders) => folders.snapshot).pipe(
            Effect.provide(cloud.layerFor("user_bob")),
          )).folders.find((folder) => folder.id === fork.id)?.origin,
        ).toEqual(fork.origin);
        const targetId = fork.files!.projectId.slice("drive:".length);
        yield* Effect.gen(function* () {
          const directory = yield* DriveDirectory;
          const target = directory.forDrive(targetId);
          const reader = yield* makeDriveReader(targetId);
          expect((yield* reader.commit(head)).message.trim()).toBe("Start the idea");
          expect((yield* target.log(head, 10)).map((commit) => commit.oid)).toEqual([head]);
          repo.write("idea.md", "A different idea\n");
          const next = repo.commit("Try another approach");
          const packed = repo.pack([next], [head]);
          expect((yield* uploadPack({ driveId: targetId, threadId: "work", ...packed }))._tag).toBe(
            "ok",
          );
          expect(
            (yield* target.replaceMain("user_bob", { expectedMain: head, newMain: next }))._tag,
          ).toBe("ok");
          expect(yield* directory.forDrive(drive.id).ref(MAIN_REF)).toBe(head);
          expect(yield* target.ref(MAIN_REF)).toBe(next);
          expect(yield* directory.forDrive(drive.id).role("user_bob")).toBeNull();
          expect(yield* target.role(USER)).toBeNull();
        }).pipe(Effect.provide(cloud.drives.layer));
        yield* UserFolders.use((folders) => folders.delete({ id: fork.id })).pipe(
          Effect.provide(cloud.layerFor("user_bob")),
        );
        expect(yield* Effect.promise(() => cloud.drives.apiFor(drive.id).ref(MAIN_REF))).toBe(head);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps the owner, remembers the origin through move and deletion, and retries once",
    () =>
      Effect.gen(function* () {
        const cloud = yield* setup;
        yield* Effect.gen(function* () {
          const folders = yield* UserFolders;
          const starts = yield* FolderStarts;
          const created = yield* folders.create({
            name: "Original",
            ownerId: ACME,
            parentId: null,
          });
          const source = created.folders.find((folder) => folder.name === "Original")!;
          const id = FolderId.make("new-approach");
          const result = yield* starts.startFrom({ id: source.id, newFolderId: id });
          const fork = result.folders.find((folder) => folder.id === id)!;
          expect(fork).toMatchObject({
            parentId: null,
            ownerId: ACME,
            name: "Original (copy)",
            origin: {
              folderId: source.id,
              name: "Original",
              driveId: `my/${ACME}/${USER}`,
              commit: null,
            },
          });
          expect(result.folders.find((folder) => folder.id === source.id)).toEqual(source);
          expect(
            (yield* starts.startFrom({ id: source.id, newFolderId: id })).folders,
          ).toHaveLength(2);
          const parent = yield* folders.create({ name: "My ideas", ownerId: ACME, parentId: null });
          yield* folders.move({
            id,
            parentId: parent.folders.find((folder) => folder.name === "My ideas")!.id,
          });
          yield* folders.update({ id, name: "React approach" });
          yield* folders.delete({ id: source.id });
          expect(
            (yield* folders.snapshot).folders.find((folder) => folder.id === id)?.origin,
          ).toEqual(fork.origin);
          yield* folders.delete({ id });
          expect((yield* folders.snapshot).folders.map((folder) => folder.name)).toEqual([
            "My ideas",
          ]);
          expect(
            (yield* starts
              .startFrom({ id: source.id, newFolderId: FolderId.make("gone") })
              .pipe(Effect.flip)).message,
          ).toBe("That folder no longer exists.");
        }).pipe(Effect.provide(cloud.layerFor(USER)));
      }),
  );
});
