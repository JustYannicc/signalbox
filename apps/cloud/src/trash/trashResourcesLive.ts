import { ProjectId, ThreadId } from "@t3tools/contracts";
import { SignalboxTrashError } from "@t3tools/contracts/signalboxTrash";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { ThreadDirectory } from "../thread/ThreadDirectory.ts";
import { driveOfProject } from "../user/contextProjects.ts";
import { UserFolders } from "../user/UserFolders.ts";
import type * as FolderTrashStore from "../user/folderTrash.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { TrashResources, type FolderTrash } from "./TrashResources.ts";
import { RETENTION_MS, type Removal } from "./trashTables.ts";
import * as TrashAutomations from "./trashAutomations.ts";

const IndexedThread = Schema.Struct({ thread_id: ThreadId, project_id: ProjectId });
const decodeIndexed = Schema.decodeUnknownSync(Schema.Array(IndexedThread));
const failed = (message: string) => new SignalboxTrashError({ message });

const make = Effect.gen(function* () {
  const threads = yield* ThreadDirectory;
  const drives = yield* Effect.serviceOption(DriveDirectory);
  const drive = (id: string) =>
    Option.isSome(drives)
      ? Effect.succeed(drives.value.forDrive(id))
      : Effect.fail(failed("Drive storage is unavailable."));
  const folders = yield* UserFolders;
  const sql = yield* SqlClient.SqlClient;
  const automations = yield* TrashAutomations.TrashAutomations;
  const guarded = <A, E>(effect: Effect.Effect<A, E>, operation: string) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logError(`trash ${operation} failed`, { cause })),
      Effect.mapError(() => failed(`Could not ${operation}. Trash will retry.`)),
    );
  const folderRecord = (actor: Actor, record: FolderTrashStore.Record) =>
    Effect.gen(function* () {
      if (!actor.contextIds.includes(record.ownerId))
        return yield* failed("That folder is not available to you.");
      const indexed =
        record.threadIds.length === 0
          ? []
          : decodeIndexed(
              yield* sql`SELECT thread_id, json_extract(shell, '$.projectId') AS project_id FROM thread_index
        WHERE thread_id IN ${sql.in(record.threadIds)}`,
            );
      const targets = indexed.map((thread) => ({
        threadId: thread.thread_id,
        driveId: driveOfProject(thread.project_id, actor.userId),
      }));
      if (targets.length !== record.threadIds.length) {
        return yield* failed(
          "The folder's thread index is incomplete. Its retained work is safe; cleanup will retry.",
        );
      }
      return {
        id: record.trashId,
        folderId: record.folderId,
        title: record.title,
        contextId: record.ownerId,
        deletedAt: record.deletedAt,
        purgeAfter: record.restoreUntil,
        targets,
        driveIds: record.driveIds,
      } satisfies FolderTrash;
    });
  const describeThread: TrashResources["Service"]["describeThread"] = (actor, id) =>
    guarded(
      Effect.gen(function* () {
        const summary = yield* threads.forThread(ThreadId.make(id)).summary(actor);
        if (summary === null || !actor.contextIds.includes(summary.contextId)) {
          return yield* failed("That thread is not available to you.");
        }
        if (summary.shell.deletedAt !== null)
          return yield* failed("That thread is already in Trash.");
        return {
          title: summary.shell.title,
          contextId: summary.contextId,
          target: { threadId: id, driveId: driveOfProject(summary.shell.projectId, actor.userId) },
        };
      }),
      "move the thread to Trash",
    );
  const prepare: TrashResources["Service"]["prepare"] = (actor, row) =>
    guarded(
      Effect.gen(function* () {
        let ready = true;
        for (const target of row.targets) {
          const receipt = yield* threads.forThread(ThreadId.make(target.threadId)).trash(actor, {
            trashId: row.id,
            deletedAt: row.deleted_at,
            purgeAfter: row.purge_after,
          });
          if (receipt.trashId !== row.id || receipt.state !== "trashed") {
            return yield* failed("The thread belongs to a different Trash entry.");
          }
          ready = receipt.ready && ready;
        }
        const automated = yield* automations.prepareAutomationTrash(
          row.targets.map((target) => target.threadId),
          row.id,
        );
        for (const retained of automated.retained) {
          yield* Effect.logInfo("Trash retains a shared automation run", {
            "trash.id": row.id,
            "automation.run_id": retained.id,
            reason: retained.reason,
          });
        }
        ready = automated.ready && ready;
        return ready;
      }),
      "finish saving and releasing the machine",
    );
  const restore: TrashResources["Service"]["restore"] = (actor, row) =>
    guarded(
      Effect.gen(function* () {
        if (row.kind === "folder")
          yield* folders.restoreTrash(row.id, row.restore_started_at ?? undefined);
        for (const target of row.targets) {
          const receipt = yield* threads
            .forThread(ThreadId.make(target.threadId))
            .restore(actor, { trashId: row.id });
          if (receipt.state !== "restored" || receipt.trashId !== row.id) {
            return yield* failed("The thread could not be restored.");
          }
        }
      }),
      "restore the item",
    );
  const purge: TrashResources["Service"]["purge"] = (actor, row) =>
    guarded(
      Effect.gen(function* () {
        const removals = [
          ...(yield* automations.purgeAutomationTrash(
            row.targets.map((target) => target.threadId),
            row.id,
          )),
        ];
        const now = yield* Clock.currentTimeMillis;
        for (const target of row.targets) {
          const receipt = yield* threads.forThread(ThreadId.make(target.threadId)).purge(actor, {
            trashId: row.id,
            empty: row.purge_after < row.deleted_at + RETENTION_MS,
          });
          if (receipt.state !== "purged" || !receipt.ready)
            return yield* failed("Thread cleanup is still pending.");
          removals.push(...(receipt.removals ?? []), { kind: "thread", id: target.threadId });
          if (target.driveId !== null) {
            const driveReceipt = yield* (yield* drive(target.driveId)).purgeThread({
              purgeId: `${row.id}:${target.threadId}`,
              threadId: target.threadId,
              purgedAt: now,
              gcAfter: now + RETENTION_MS,
            });
            for (const ref of driveReceipt.removedRefs)
              removals.push({ kind: "drive-ref", id: `${target.driveId}/${ref.name}` });
          }
          // The deleted shell stays as the outbox revision fence; these auxiliary records have no
          // remaining use. ThreadStore keeps the durable purge receipt and rejects late commands.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM thread_homes WHERE thread_id = ${target.threadId}`;
              yield* sql`DELETE FROM thread_kinds WHERE thread_id = ${target.threadId}`;
            }),
          );
        }
        if (row.kind === "folder") {
          for (const driveId of row.drive_ids) {
            // A shared or independently retained binding keeps using this drive.
            const [other] = yield* sql`SELECT 1 FROM folders WHERE drive_id = ${driveId}
              AND (trash_id IS NULL OR trash_id <> ${row.id}) LIMIT 1`;
            if (other !== undefined) continue;
            const result = yield* (yield* drive(driveId)).purgeDrive({
              userId: actor.userId,
              purgeId: `${row.id}:drive:${driveId}`,
              purgedAt: now,
              gcAfter: now + RETENTION_MS,
            });
            if (result._tag === "retained") {
              yield* Effect.logInfo("Trash retains a shared drive", {
                "trash.id": row.id,
                "drive.id": driveId,
                reason: result.reason,
              });
              continue;
            }
            removals.push({ kind: "drive", id: driveId });
            for (const ref of result.receipt.removedRefs) {
              removals.push({ kind: "drive-ref", id: `${driveId}/${ref.name}` });
            }
          }
          const { trash } = yield* folders.purgeTrash(row.id);
          removals.push(...trash.folderIds.map((id) => ({ kind: "folder", id })));
          removals.push(...trash.noteIds.map((id) => ({ kind: "note", id })));
        }
        return removals;
      }),
      "purge the item's resources",
    );
  const collect: TrashResources["Service"]["collect"] = (actor, row) =>
    guarded(
      Effect.gen(function* () {
        const removals: Array<Removal> = [];
        for (const target of row.targets) {
          if (target.driveId === null) continue;
          const receipt = yield* (yield* drive(target.driveId)).collectPurgedPacks(
            `${row.id}:${target.threadId}`,
            yield* Clock.currentTimeMillis,
            100,
          );
          if (receipt === null) continue;
          if (receipt.pendingPackNames.length > 0)
            return yield* failed("More unreferenced packs await collection.");
          for (const name of receipt.removedPackNames)
            removals.push({ kind: "drive-pack", id: `${target.driveId}/${name}` });
        }
        for (const driveId of row.drive_ids) {
          const receipt = yield* (yield* drive(driveId)).collectPurgedPacks(
            `${row.id}:drive:${driveId}`,
            yield* Clock.currentTimeMillis,
            100,
          );
          if (receipt === null) continue;
          if (receipt.pendingPackNames.length > 0)
            return yield* failed("More unreferenced packs await collection.");
          for (const name of receipt.removedPackNames)
            removals.push({ kind: "drive-pack", id: `${driveId}/${name}` });
        }
        return removals;
      }),
      "collect unreferenced packs",
    );
  return TrashResources.of({
    describeThread,
    prepare,
    restore,
    purge,
    collect,
    acknowledge: automations.acknowledgeAutomationTrash,
    trashFolder: (actor, id) =>
      guarded(
        folders.trash({ id }).pipe(Effect.flatMap(({ trash }) => folderRecord(actor, trash))),
        "move the folder to Trash",
      ),
    folderTrashes: (actor) =>
      guarded(
        folders.activeTrashes.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows.filter((row) => actor.contextIds.includes(row.ownerId)),
              (row) => folderRecord(actor, row),
            ),
          ),
        ),
        "recover folder trash",
      ),
  });
});

export const layer = Layer.effect(TrashResources, make).pipe(
  Layer.provideMerge(TrashAutomations.layer),
);
