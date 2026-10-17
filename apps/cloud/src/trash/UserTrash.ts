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
      purgeEnabled: workflows.enabled,
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
  const process = (actor: Actor, id: string) =>
    Effect.gen(function* () {
      let row = yield* requireRow(actor, id);
      yield* Effect.annotateCurrentSpan({
        "context.id": row.context_id,
        ...(row.kind === "folder"
          ? { "folder.id": row.target_id }
          : { "thread.id": row.target_id }),
      });
      const now = yield* Clock.currentTimeMillis;
      if (row.status === "restored") return { done: true, nextAt: now };
      if (row.status === "restoring") {
        yield* resources.restore(actor, row);
        yield* journal.restored(id);
        return { done: true, nextAt: now };
      }
      if (row.status === "trashed" && row.prepared === 0) {
        if (!(yield* resources.prepare(actor, row))) return { done: false, nextAt: now + RETRY_MS };
        yield* journal.prepared(id);
        row = yield* requireRow(actor, id);
      }
      if (!workflows.enabled) return { done: false, nextAt: now + RETENTION_MS / 30 };
      if (row.status === "trashed") {
        if (row.purge_after > now) return { done: false, nextAt: row.purge_after };
        // Restore and purge race only on this claim, before any irreversible action.
        yield* journal.claimPurge(id, now);
        row = yield* requireRow(actor, id);
      }
      if (row.status === "purging") {
        yield* journal.record(id, yield* resources.purge(actor, row));
        if (resources.acknowledge !== undefined) yield* resources.acknowledge(id);
        yield* journal.purged(id, now + RETENTION_MS);
        return { done: false, nextAt: now + RETENTION_MS };
      }
      if (row.status === "purged" && row.gc_after !== null) {
        if (row.gc_after > now) return { done: false, nextAt: row.gc_after };
        yield* journal.record(id, yield* resources.collect(actor, row));
        yield* journal.collected(id);
      }
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
  const empty: UserTrash["Service"]["empty"] = ({ ids }) =>
    call(
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (!workflows.enabled)
            return yield* refused("Permanent purge has not been enabled on this server.");
          const actor = yield* actorNow;
          const selected =
            ids === undefined
              ? (yield* journal.pending).filter(
                  (row) => visible(actor, row) && row.status === "trashed",
                )
              : yield* Effect.forEach([...new Set(ids)], (id) => requireRow(actor, id));
          const now = yield* Clock.currentTimeMillis;
          yield* alarm.armBy(now + RETRY_MS);
          for (const row of selected) {
            if (row.status === "restoring" || row.status === "restored") {
              return yield* refused("A restoring or restored item cannot be emptied.");
            }
          }
          for (const row of selected) {
            yield* journal.expire(row.id, now);
            yield* start(actor, row.id);
          }
          return yield* list;
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
          yield* journal.put({ ...folder, kind: "folder", targetId: folder.folderId });
        }
        const pending = (yield* journal.pending).filter((row) => visible(actor, row));
        for (const row of pending) {
          // Reconcile existing instances too: a Workflow can fail after its launch was acknowledged.
          // The binding resumes active instances and restarts errored ones under the same id.
          yield* schedule(actor, row.id);
          if (row.status === "restoring" || row.prepared === 0 || row.status === "purging") {
            yield* attempt(actor, row.id);
          }
        }
        const needsRecovery = (yield* journal.pending).some(
          (row) =>
            visible(actor, row) &&
            (row.scheduled === 0 ||
              row.status === "restoring" ||
              row.prepared === 0 ||
              row.status === "purging"),
        );
        if (pending.length > 0)
          yield* alarm.armBy(
            (yield* Clock.currentTimeMillis) + (needsRecovery ? RETRY_MS : RETENTION_MS / 30),
          );
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
    recover: recover.pipe(traced("UserTrash.recover", {})),
    progress: (id) =>
      call(lock.withPermits(1)(Effect.flatMap(actorNow, (actor) => attempt(actor, id)))).pipe(
        traced("UserTrash.progress", { "trash.id": id }),
      ),
  });
});

export const layer = Layer.effect(UserTrash, make);
