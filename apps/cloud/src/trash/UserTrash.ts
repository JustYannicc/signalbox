import { ThreadId } from "@t3tools/contracts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import {
  SignalboxTrashError,
  TrashEntryId,
  type TrashSnapshot,
} from "@t3tools/contracts/signalboxTrash";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import type { Actor } from "../thread/ThreadEngine.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { UserStore } from "../user/UserStore.ts";
import { makeTraced } from "../user/tracing.ts";
import { makeJournal } from "./TrashJournal.ts";
import { TrashResources } from "./TrashResources.ts";
import { TrashAlarm, TrashWorkflow, type TrashProgress } from "./TrashWorkflow.ts";
import { RETENTION_MS, RETRY_MS, type Row } from "./trashTables.ts";

type Result<A> = Effect.Effect<A, SignalboxTrashError>;

export class UserTrash extends Context.Service<
  UserTrash,
  {
    readonly list: Result<TrashSnapshot>;
    readonly trashThread: (input: {
      readonly threadId: string;
      readonly commandId?: string;
    }) => Result<TrashSnapshot>;
    readonly trashFolder: (input: { readonly folderId: FolderId }) => Result<TrashSnapshot>;
    readonly restore: (input: { readonly id: string }) => Result<TrashSnapshot>;
    readonly empty: (input: { readonly ids?: ReadonlyArray<string> }) => Result<TrashSnapshot>;
    readonly progress: (id: string) => Result<TrashProgress>;
    /** Arms the object alarm for local recovery work without calling remote resources. */
    readonly armRecovery: Result<void>;
    readonly recover: Result<void>;
  }
>()("@signalbox/cloud/trash/UserTrash") {}

const refused = (message: string) => new SignalboxTrashError({ message });

const make = Effect.gen(function* () {
  const journal = yield* makeJournal;
  const resources = yield* TrashResources;
  const workflows = yield* TrashWorkflow;
  const alarm = yield* TrashAlarm;
  const users = yield* UserStore;
  const drives = yield* UserDrives;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const traced = makeTraced(Effect.map(users.profile, (profile) => profile?.id ?? null));
  const call = <A>(effect: Effect.Effect<A, SignalboxTrashError | { readonly _tag: "SqlError" }>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error._tag === "SqlError" ? refused("Could not read or change Trash.") : error,
      ),
    );
  const actorNow = Effect.gen(function* () {
    const profile = yield* users.profile;
    if (profile === null) return yield* refused("Sign in before changing Trash.");
    return { userId: profile.id, contextIds: yield* drives.contextIds } satisfies Actor;
  });
  const needsRecovery = (row: Row) =>
    row.status === "restoring" || (row.status === "trashed" && row.prepared === 0);
  const visible = (actor: Actor, row: Row) => actor.contextIds.some((id) => id === row.context_id);
  const requireRow = (actor: Actor, id: string) =>
    Effect.gen(function* () {
      const row = yield* journal.read(id);
      if (row === null || !visible(actor, row))
        return yield* refused("That item is not in your Trash.");
      return row;
    });
  const list = Effect.gen(function* () {
    const actor = yield* actorNow;
    const rows = yield* journal.all;
    return {
      purgeEnabled: false,
      entries: rows
        .filter((row) => visible(actor, row))
        .map((row) => ({
          id: TrashEntryId.make(row.id),
          kind: row.kind,
          targetId: row.target_id,
          title: row.title,
          deletedAt: row.deleted_at,
          purgeAfter: row.purge_after,
          status: row.status,
          threadIds: row.targets.map((target) => ThreadId.make(target.threadId)),
          plannedRemovals: row.planned_removals,
          removals: row.removals,
          error: row.error,
        })),
    } satisfies TrashSnapshot;
  });
  const schedule = (actor: Actor, id: string) =>
    Effect.gen(function* () {
      // Arm before the remote launch. A process cut off at either await still has a recovery trigger.
      yield* alarm.armBy((yield* Clock.currentTimeMillis) + RETRY_MS);
      yield* workflows.start(actor.userId, id).pipe(
        Effect.andThen(journal.scheduled(id)),
        Effect.catch((error) => journal.error(id, error.message)),
      );
    });
  const restoreGate = (actor: Actor, row: Row) =>
    Effect.gen(function* () {
      if (row.kind === "thread") {
        const hiddenHome = yield* resources.trashedHomeOfThread(actor, {
          id: row.target_id,
          context_id: row.context_id,
        });
        if (hiddenHome === null) return "clear" as const;
        yield* journal.error(row.id, "Restore its folder, then this thread.");
        return "blocked" as const;
      }
      const preflight = yield* resources.folderRestorePreflight(actor, {
        id: row.id,
        context_id: row.context_id,
      });
      if (preflight === null || preflight.parentTrashedAt === null) return "clear" as const;
      const message = "Restore the parent folder first.";
      if (
        row.status === "restoring" &&
        preflight.status === "trashed" &&
        row.restore_started_at !== null
      ) {
        if (yield* journal.restoreBlocked(row.id, row.restore_started_at, message)) {
          return "reset" as const;
        }
      }
      yield* journal.error(row.id, message);
      return "blocked" as const;
    });
  const process = (actor: Actor, id: string) =>
    Effect.gen(function* () {
      const row = yield* requireRow(actor, id);
      yield* Effect.annotateCurrentSpan({
        "context.id": row.context_id,
        ...(row.kind === "folder"
          ? { "folder.id": row.target_id }
          : { "thread.id": row.target_id }),
      });
      const now = yield* Clock.currentTimeMillis;
      if (row.status === "restored") return { done: true, nextAt: now };
      if (row.status === "restoring") {
        const gate = yield* restoreGate(actor, row);
        if (gate === "reset") return { done: true, nextAt: now };
        if (gate === "blocked") return { done: false, nextAt: now + RETRY_MS };
        yield* resources.restore(actor, row);
        yield* journal.restored(id);
        return { done: true, nextAt: now };
      }
      if (row.status === "trashed" && row.prepared === 0) {
        if (!(yield* resources.prepare(actor, row))) return { done: false, nextAt: now + RETRY_MS };
        yield* journal.prepared(id);
      }
      // The entry stays recoverable through its retention window. Physical cleanup is a later change.
      return { done: true, nextAt: now };
    });
  const attempt = (actor: Actor, id: string) =>
    process(actor, id).pipe(
      Effect.catchTags({
        SignalboxTrashError: (error) =>
          Effect.gen(function* () {
            yield* journal.error(id, error.message);
            const nextAt = (yield* Clock.currentTimeMillis) + RETRY_MS;
            yield* alarm.armBy(nextAt);
            return { done: false, nextAt };
          }),
      }),
    );
  const start = (actor: Actor, id: string) =>
    Effect.gen(function* () {
      yield* schedule(actor, id);
      yield* attempt(actor, id);
    });
  const trashThread: UserTrash["Service"]["trashThread"] = ({ threadId, commandId }) =>
    call(
      lock.withPermits(1)(
        Effect.gen(function* () {
          const actor = yield* actorNow;
          const requested = commandId === undefined ? null : yield* journal.request(commandId);
          if (requested !== null) {
            if (requested.kind !== "thread" || requested.target_id !== threadId) {
              return yield* refused("That command id already refers to another item.");
            }
            yield* requireRow(actor, requested.trash_id);
            return yield* list;
          }
          const existing = yield* journal.active("thread", threadId);
          if (existing !== null) {
            yield* requireRow(actor, existing.id);
            if (existing.status === "restoring") {
              return yield* refused("That thread is being restored. Try again after it finishes.");
            }
            if (commandId !== undefined)
              yield* journal.rememberRequest(commandId, "thread", threadId, existing.id);
            yield* start(actor, existing.id);
            return yield* list;
          }
          const described = yield* resources.describeThread(actor, threadId);
          const deletedAt = yield* Clock.currentTimeMillis;
          const id = yield* Effect.orDie(crypto.randomUUIDv4());
          yield* alarm.armBy(deletedAt + RETRY_MS);
          yield* journal.put({
            id,
            kind: "thread",
            targetId: threadId,
            folderId: "",
            title: described.title,
            contextId: described.contextId,
            deletedAt,
            purgeAfter: deletedAt + RETENTION_MS,
            targets: [described.target],
            driveIds: [],
            plannedRemovals: described.plannedRemovals,
            ...(commandId === undefined ? {} : { commandId }),
          });
          yield* start(actor, id);
          return yield* list;
        }),
      ),
    );
  const trashFolder: UserTrash["Service"]["trashFolder"] = ({ folderId }) =>
    call(
      lock.withPermits(1)(
        Effect.gen(function* () {
          const actor = yield* actorNow;
          const existing = yield* journal.active("folder", folderId);
          if (existing !== null) {
            yield* requireRow(actor, existing.id);
            if (existing.status === "restoring") {
              return yield* refused("That folder is being restored. Try again after it finishes.");
            }
            yield* start(actor, existing.id);
          } else {
            yield* alarm.armBy((yield* Clock.currentTimeMillis) + RETRY_MS);
            const folder = yield* resources.trashFolder(actor, folderId);
            yield* journal.put({ ...folder, kind: "folder", targetId: folderId });
            yield* start(actor, folder.id);
          }
          return yield* list;
        }),
      ),
    );
  const restore: UserTrash["Service"]["restore"] = ({ id }) =>
    call(
      lock.withPermits(1)(
        Effect.gen(function* () {
          const actor = yield* actorNow;
          const row = yield* requireRow(actor, id);
          if (row.status === "restored") return yield* list;
          const gate = yield* restoreGate(actor, row);
          if (gate === "reset") return yield* list;
          if (gate === "blocked") {
            if (row.status === "restoring")
              yield* alarm.armBy((yield* Clock.currentTimeMillis) + RETRY_MS);
            return yield* list;
          }
          if (
            row.status !== "restoring" &&
            !(yield* journal.restore(id, yield* Clock.currentTimeMillis))
          ) {
            return yield* refused("The restore window has ended or this item is being purged.");
          }
          yield* alarm.armBy((yield* Clock.currentTimeMillis) + RETRY_MS);
          yield* attempt(actor, id);
          return yield* list;
        }),
      ),
    );
  const empty: UserTrash["Service"]["empty"] = () =>
    call(Effect.fail(refused("Permanent cleanup is not available yet.")));
  const armRecovery = call(
    lock.withPermits(1)(
      Effect.gen(function* () {
        const profile = yield* users.profile;
        if (profile === null) return;
        const actor = { userId: profile.id, contextIds: yield* drives.contextIds } satisfies Actor;
        const journalPending = (yield* journal.pending).some(
          (row) => visible(actor, row) && needsRecovery(row),
        );
        const unjournaledFolders = yield* resources.folderTrashes(actor);
        if (journalPending || unjournaledFolders.length > 0) {
          yield* alarm.armBy((yield* Clock.currentTimeMillis) + RETRY_MS);
        }
      }),
    ),
  );
  const recover = call(
    lock.withPermits(1)(
      Effect.gen(function* () {
        const profile = yield* users.profile;
        if (profile === null) return;
        const actor = yield* actorNow;
        // A folder's transaction can land before its enclosing trash request writes this journal.
        for (const folder of yield* resources.folderTrashes(actor)) {
          yield* journal.put({
            ...folder,
            kind: "folder",
            targetId: folder.folderId,
            plannedRemovals: folder.plannedRemovals,
          });
        }
        const pending = (yield* journal.pending).filter((row) => visible(actor, row));
        for (const row of pending) {
          if (needsRecovery(row)) {
            // Preparation is idempotent; the user-object alarm retries a cut-off request.
            yield* schedule(actor, row.id);
            yield* attempt(actor, row.id);
          }
        }
        const hasRecovery = (yield* journal.pending).some(
          (row) => visible(actor, row) && needsRecovery(row),
        );
        if (hasRecovery) yield* alarm.armBy((yield* Clock.currentTimeMillis) + RETRY_MS);
      }),
    ),
  );
  return UserTrash.of({
    list: call(list).pipe(traced("UserTrash.list", {})),
    trashThread: (input) =>
      trashThread(input).pipe(traced("UserTrash.trashThread", { "thread.id": input.threadId })),
    trashFolder: (input) =>
      trashFolder(input).pipe(traced("UserTrash.trashFolder", { "folder.id": input.folderId })),
    restore: (input) => restore(input).pipe(traced("UserTrash.restore", { "trash.id": input.id })),
    empty: (input) => empty(input).pipe(traced("UserTrash.empty", {})),
    armRecovery: armRecovery.pipe(traced("UserTrash.armRecovery", {})),
    recover: recover.pipe(traced("UserTrash.recover", {})),
    progress: (id) =>
      call(lock.withPermits(1)(Effect.flatMap(actorNow, (actor) => attempt(actor, id)))).pipe(
        traced("UserTrash.progress", { "trash.id": id }),
      ),
  });
});

export const layer = Layer.effect(UserTrash, make);
