import { ThreadId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemoryStore } from "../testing.ts";
import { projectIdForDrive } from "./contextProjects.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserStore from "./UserStore.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";

const USER = "user_1";
const DRIVE = "folder/personal/k1";
const SCRATCH = "scratch";

const services = Effect.all({
  folders: UserFolders.UserFolders,
  contexts: UserContexts.UserContexts,
  drives: UserDriveIndex.UserDriveIndex,
  store: UserStore.UserStore,
  sql: SqlClient.SqlClient,
});

const indexThread = (threadId: ThreadId, projectId: string, deletedAt: number | null = null) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`INSERT INTO thread_index (thread_id, context_id, revision, shell, updated_at)
      VALUES (${threadId}, ${PERSONAL_CONTEXT_ID}, 1,
        ${JSON.stringify({ id: threadId, projectId, deletedAt })}, 0)`,
  );

const reasonOf = <A>(
  effect: Effect.Effect<A, { readonly _tag: string; readonly reason?: unknown }>,
) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason ?? error._tag),
  );

describe("folder trash", () => {
  it.effect("hides and restores a folder subtree with its settings, homes, drive and notes", () =>
    Effect.gen(function* () {
      const { folders, store, sql, drives } = yield* services;
      yield* store.recordSignIn({ id: USER, email: "a@b.c" });
      yield* drives.record({
        driveId: DRIVE,
        name: "Client files",
        role: "editor",
        sharedBy: null,
        revision: 1,
      });

      let snapshot = yield* folders.create({ name: "Clients", parentId: null });
      const root = snapshot.folders.find((folder) => folder.name === "Clients")!;
      snapshot = yield* folders.create({ name: "Quarterly", parentId: root.id });
      const child = snapshot.folders.find((folder) => folder.name === "Quarterly")!;
      snapshot = yield* folders.create({ name: "Invoices", parentId: child.id });
      const leaf = snapshot.folders.find((folder) => folder.name === "Invoices")!;
      snapshot = yield* folders.create({ name: "Elsewhere", parentId: null });
      const elsewhere = snapshot.folders.find((folder) => folder.name === "Elsewhere")!;
      const driveProject = projectIdForDrive(DRIVE);
      const liveThread = ThreadId.make("thread-live");
      const driveThread = ThreadId.make("thread-drive");
      const filedElsewhereThread = ThreadId.make("thread-drive-filed-elsewhere");
      const deletedThread = ThreadId.make("thread-already-deleted");
      yield* indexThread(liveThread, SCRATCH);
      yield* indexThread(driveThread, driveProject);
      yield* indexThread(filedElsewhereThread, driveProject);
      yield* indexThread(deletedThread, SCRATCH, 900);
      yield* folders.moveThread({ threadId: liveThread, folderId: leaf.id });
      yield* folders.moveThread({ threadId: filedElsewhereThread, folderId: elsewhere.id });
      yield* folders.moveThread({ threadId: deletedThread, folderId: child.id });
      yield* folders.update({ id: root.id, files: driveProject, poolId: PERSONAL_POOL_ID });
      yield* folders.setInstructions({
        level: { _tag: "folder", folderId: root.id },
        instructions: "Keep client work private.",
      });
      yield* folders.setInstructions({
        level: { _tag: "folder", folderId: leaf.id },
        instructions: "Keep the invoice trail.",
      });
      yield* folders.setSecrets({
        level: { _tag: "folder", folderId: child.id },
        secrets: { environmentId: OnePasswordEnvironmentId.make("env_clients") },
      });
      yield* folders.setGitHubLend(root.id, "octo");
      yield* sql`INSERT INTO notes (id, folder_id, author_id, visibility, text, created_at)
        VALUES ('note-invoices', ${leaf.id}, ${USER}, 'private', 'Keep this note here.', 1)`;

      const notesBefore = yield* sql`SELECT id, folder_id, author_id, visibility, text, created_at
        FROM notes WHERE id = 'note-invoices'`;
      const trashed = yield* folders.trash({ id: root.id });
      expect(trashed.trash.folderIds.toSorted()).toEqual([root.id, child.id, leaf.id].toSorted());
      expect(trashed.trash.driveIds).toEqual([DRIVE]);
      expect(trashed.trash.threadIds.toSorted()).toEqual([liveThread, driveThread].toSorted());
      expect(trashed.trash.threadIds).not.toContain(filedElsewhereThread);
      expect(trashed.trash.noteIds).toEqual(["note-invoices"]);
      expect(trashed.trash.threadIds).not.toContain(deletedThread);
      expect(trashed.snapshot.folders.map((folder) => folder.id)).not.toEqual(
        expect.arrayContaining([root.id, child.id, leaf.id]),
      );
      expect(trashed.snapshot.threadHomes).toContainEqual({
        threadId: filedElsewhereThread,
        folderId: elsewhere.id,
      });
      expect((yield* folders.rows).folders.map((folder) => folder.id)).not.toEqual(
        expect.arrayContaining([root.id, child.id, leaf.id]),
      );
      expect((yield* folders.rows).bindings.some((binding) => binding.level_id === root.id)).toBe(
        false,
      );
      expect(yield* folders.driveIsTrashed(DRIVE)).toBe(true);
      expect(
        yield* folders.turn({ threadId: liveThread, projectId: null }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ThreadHomeTrashedError" });
      expect(
        yield* sql`SELECT id FROM folders WHERE trash_id = ${trashed.trash.trashId}
          ORDER BY id`,
      ).toHaveLength(3);
      expect(
        yield* sql`SELECT id, folder_id, author_id, visibility, text, created_at
        FROM notes WHERE id = 'note-invoices'`,
      ).toEqual(notesBefore);

      const repeatedDelete = yield* folders.trash({ id: root.id });
      expect(repeatedDelete.trash.trashId).toBe(trashed.trash.trashId);
      expect(yield* reasonOf(folders.update({ id: elsewhere.id, files: driveProject }))).toBe(
        "invalid",
      );
      expect(yield* reasonOf(folders.moveThread({ threadId: liveThread, folderId: null }))).toBe(
        "invalid",
      );
      expect(
        yield* sql`SELECT id FROM folders WHERE drive_id = ${DRIVE}
          AND trash_id = ${trashed.trash.trashId}`,
      ).toHaveLength(1);
      const restored = yield* folders.restoreTrash(trashed.trash.trashId);
      expect(restored.restored).toBe(true);
      expect(restored.snapshot.folders).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: root.id,
            parentId: null,
            files: { projectId: driveProject },
            poolId: PERSONAL_POOL_ID,
            instructions: "Keep client work private.",
            githubLend: expect.objectContaining({ login: "octo" }),
          }),
          expect.objectContaining({
            id: child.id,
            parentId: root.id,
            secrets: { environmentId: "env_clients" },
          }),
          expect.objectContaining({
            id: leaf.id,
            parentId: child.id,
            instructions: "Keep the invoice trail.",
          }),
        ]),
      );
      expect(restored.snapshot.threadHomes).toContainEqual({
        threadId: liveThread,
        folderId: leaf.id,
      });
      expect(restored.snapshot.projectHomes).toContainEqual({
        projectId: driveProject,
        folderId: root.id,
      });
      expect(
        yield* sql`SELECT id, folder_id, author_id, visibility, text, created_at
        FROM notes WHERE id = 'note-invoices'`,
      ).toEqual(notesBefore);
      expect((yield* folders.restoreTrash(trashed.trash.trashId)).restored).toBe(false);

      const trashedAgain = yield* folders.trash({ id: root.id });
      expect(trashedAgain.trash.trashId).not.toBe(trashed.trash.trashId);
      expect(yield* folders.trashDetails(trashedAgain.trash.trashId)).toMatchObject({
        status: "trashed",
        folderIds: [root.id, child.id, leaf.id].toSorted(),
        noteIds: ["note-invoices"],
      });
      expect(yield* sql`SELECT id FROM notes WHERE id = 'note-invoices'`).toHaveLength(1);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("leaves a separately trashed child as an independent receipt", () =>
    Effect.gen(function* () {
      const { folders, store } = yield* services;
      yield* store.recordSignIn({ id: USER, email: "a@b.c" });
      let snapshot = yield* folders.create({ name: "Parent", parentId: null });
      const parent = snapshot.folders.find((folder) => folder.name === "Parent")!;
      snapshot = yield* folders.create({ name: "Child", parentId: parent.id });
      const child = snapshot.folders.find((folder) => folder.name === "Child")!;

      const childTrash = yield* folders.trash({ id: child.id });
      const parentTrash = yield* folders.trash({ id: parent.id });
      expect(parentTrash.trash.folderIds).toEqual([parent.id]);
      expect(parentTrash.trash.trashId).not.toBe(childTrash.trash.trashId);

      const blockedRestore = yield* folders
        .restoreTrash(childTrash.trash.trashId)
        .pipe(Effect.flip);
      expect(blockedRestore.message).toBe("Restore the parent folder first.");
      yield* folders.restoreTrash(parentTrash.trash.trashId);
      expect(
        (yield* folders.restoreTrash(childTrash.trash.trashId)).snapshot.folders,
      ).toContainEqual(expect.objectContaining({ id: child.id, parentId: parent.id }));
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("keeps trashed sections, placements and bindings out of legacy preview rows", () =>
    Effect.gen(function* () {
      const { folders, store, sql } = yield* services;
      yield* store.recordSignIn({ id: USER, email: "a@b.c" });
      const snapshot = yield* folders.create({ name: "Legacy", parentId: null });
      const folder = snapshot.folders.find((item) => item.name === "Legacy")!;
      yield* sql`INSERT INTO sections (id, context_id, parent_id, name, position)
        VALUES (${folder.id}, 'personal', NULL, 'Legacy', 0)`;
      yield* sql`INSERT INTO project_placements (project_id, section_id, position)
        VALUES (${projectIdForDrive(DRIVE)}, ${folder.id}, 0)`;
      yield* sql`INSERT INTO resource_bindings
        (level_kind, level_id, kind, resource_id, reach, created_at)
        VALUES ('section', ${folder.id}, 'pool', 'personal', 'below', 1)`;

      yield* folders.trash({ id: folder.id });
      const legacy = yield* folders.legacyRows;
      expect(legacy.sections).toEqual([]);
      expect(legacy.placements).toEqual([]);
      expect(legacy.bindings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ level_id: folder.id })]),
      );
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});
