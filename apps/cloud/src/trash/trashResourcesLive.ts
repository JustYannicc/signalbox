import { ProjectId, ThreadId } from "@t3tools/contracts";
import { SignalboxTrashError } from "@t3tools/contracts/signalboxTrash";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadDirectory } from "../thread/ThreadDirectory.ts";
import { driveOfProject } from "../user/contextProjects.ts";
import { UserFolders } from "../user/UserFolders.ts";
import type * as FolderTrashStore from "../user/folderTrash.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { TrashResources, type FolderTrash } from "./TrashResources.ts";
import type { TrashPlannedRemoval } from "@t3tools/contracts/signalboxTrash";
import * as TrashAutomations from "./trashAutomations.ts";

const IndexedThread = Schema.Struct({ thread_id: ThreadId, project_id: Schema.NullOr(ProjectId) });
const decodeIndexed = Schema.decodeUnknownSync(Schema.Array(IndexedThread));
const failed = (message: string) => new SignalboxTrashError({ message });

const plannedForThread = (
  threadId: string,
  driveId: string | null,
): ReadonlyArray<TrashPlannedRemoval> => [
  ...(["history", "machine-cache", "previews", "attachments", "automation-runs"] as const).map(
    (resource) => ({
      _tag: "threadResource" as const,
      threadId: ThreadId.make(threadId),
      resource,
    }),
  ),
  ...(driveId === null
    ? []
    : [{ _tag: "driveThreadRefs" as const, driveId, threadId: ThreadId.make(threadId) }]),
];

const make = Effect.gen(function* () {
  const threads = yield* ThreadDirectory;
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
      const projects = new Map(indexed.map((thread) => [thread.thread_id, thread.project_id]));
      // Keep every indexed thread id. A missing project lookup limits its plan scope, not its journal.
      const targets = record.threadIds.map((threadId) => {
        const projectId = projects.get(threadId);
        return {
          threadId,
          driveId: projectId == null ? null : driveOfProject(projectId, actor.userId),
        };
      });
      const plannedRemovals: Array<TrashPlannedRemoval> = targets.flatMap((target) =>
        plannedForThread(target.threadId, target.driveId),
      );
      plannedRemovals.push(
        ...record.folderIds.map((folderId) => ({ _tag: "folder" as const, folderId })),
        ...record.noteIds.map((noteId) => ({ _tag: "note" as const, noteId })),
        ...record.driveIds.map((driveId) => ({
          _tag: "drive" as const,
          driveId,
          onlyIfUnshared: true as const,
        })),
      );
      return {
        id: record.trashId,
        folderId: record.folderId,
        title: record.title,
        contextId: record.ownerId,
        deletedAt: record.deletedAt,
        purgeAfter: record.restoreUntil,
        targets,
        driveIds: record.driveIds,
        plannedRemovals,
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
          plannedRemovals: plannedForThread(
            id,
            driveOfProject(summary.shell.projectId, actor.userId),
          ),
        };
      }),
      "move the thread to Trash",
    );
  const prepare: TrashResources["Service"]["prepare"] = (actor, row) =>
    guarded(
      Effect.gen(function* () {
        for (const target of row.targets) {
          const receipt = yield* threads.forThread(ThreadId.make(target.threadId)).trash(actor, {
            trashId: row.id,
            deletedAt: row.deleted_at,
            purgeAfter: row.purge_after,
          });
          if (receipt.trashId !== row.id || receipt.state !== "trashed") {
            return yield* failed("The thread belongs to a different Trash entry.");
          }
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
        return automated.ready;
      }),
      "prepare Trash metadata",
    );
  const restore: TrashResources["Service"]["restore"] = (actor, row) =>
    guarded(
      Effect.gen(function* () {
        // `put` and the per-thread tombstones are separate commits. Reapply the same fence before
        // restoring so a lost reply cannot leave a folder hidden with unrestorable threads.
        for (const target of row.targets) {
          const receipt = yield* threads.forThread(ThreadId.make(target.threadId)).trash(actor, {
            trashId: row.id,
            deletedAt: row.deleted_at,
            purgeAfter: row.purge_after,
          });
          if (receipt.trashId !== row.id) {
            return yield* failed("The thread belongs to a different Trash entry.");
          }
        }
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
  return TrashResources.of({
    describeThread,
    prepare,
    restore,
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
