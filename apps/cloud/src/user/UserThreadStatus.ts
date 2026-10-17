import type { FolderStatusAnswer } from "@signalbox/runner-protocol/StatusLineProtocol";
import { ThreadId as ThreadIdSchema, type ThreadId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  type SignalboxThreadStatusStreamItem,
  ThreadStatusNote,
} from "@t3tools/contracts/signalboxStatusLine";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { contextAllows } from "../drive/driveAccess.ts";
import type { ThreadSummary } from "../thread/ThreadEngine.ts";
import { folderStatusAnswer } from "./folderStatus.ts";
import { makeProfileId } from "./profileId.ts";
import { makeTraced } from "./tracing.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserStore from "./UserStore.ts";

/**
 * The user's threads' status notes (#670) in their own object: each thread's
 * latest note as its summary delivered it, served to clients as a snapshot of
 * every listed thread's note and then one item per changed note, and rolled
 * up per folder for agents (`folderStatus.ts`). A note shows only while its
 * thread's context is the user's. Spans carry ids, never what a note says.
 */

export class UserThreadStatus extends Context.Service<
  UserThreadStatus,
  {
    /** Keeps the summary's note when it's newer than the one stored, and tells open streams. */
    readonly recordSummary: (
      summary: Pick<ThreadSummary, "threadId" | "contextId" | "statusNote">,
    ) => Effect.Effect<void, SqlError>;
    /** `signalbox.threadStatus.subscribe`: the snapshot, then each changed note. */
    readonly changes: Stream.Stream<SignalboxThreadStatusStreamItem, SqlError>;
    /** What's going on in `threadId`'s home folder, for its agent. */
    readonly folderStatus: (threadId: ThreadId) => Effect.Effect<FolderStatusAnswer, SqlError>;
  }
>()("@signalbox/cloud/user/UserThreadStatus") {}

const NoteJson = Schema.fromJsonString(Schema.toCodecJson(ThreadStatusNote));
const encodeNote = Schema.encodeSync(NoteJson);
const decodeNoteRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ thread_id: ThreadIdSchema, context_id: SignalboxContextId, note: NoteJson }),
  ),
);

interface Changed {
  readonly threadId: ThreadId;
  readonly contextId: SignalboxContextId;
  readonly note: ThreadStatusNote;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* UserStore.UserStore;
  const contexts = yield* UserContexts.UserContexts;
  const folders = yield* UserFolders.UserFolders;
  const traced = makeTraced(yield* makeProfileId);
  const changed = yield* PubSub.unbounded<Changed>();

  /** Notes of indexed threads, with their context. */
  const allNotes = Effect.map(
    sql`SELECT n.thread_id, n.note, i.context_id
      FROM thread_status_notes n JOIN thread_index i ON i.thread_id = n.thread_id`,
    decodeNoteRows,
  );
  /** Notes of the threads clients list: neither archived nor deleted. */
  const listedNotes = Effect.map(
    sql`SELECT n.thread_id, n.note, i.context_id
      FROM thread_status_notes n JOIN thread_index i ON i.thread_id = n.thread_id
      WHERE json_extract(i.shell, '$.archivedAt') IS NULL
        AND json_extract(i.shell, '$.deletedAt') IS NULL
      ORDER BY n.thread_id`,
    decodeNoteRows,
  );

  const recordSummary: UserThreadStatus["Service"]["recordSummary"] = (summary) => {
    const note = summary.statusNote;
    if (note === undefined) return Effect.void;
    const writtenAt = DateTime.toEpochMillis(note.writtenAt);
    return Effect.gen(function* () {
      // A redelivered summary carries the same or an older note: nothing changes.
      const written = yield* sql`INSERT INTO thread_status_notes (thread_id, note, written_at)
        VALUES (${summary.threadId}, ${encodeNote(note)}, ${writtenAt})
        ON CONFLICT (thread_id) DO UPDATE SET note = excluded.note, written_at = excluded.written_at
        WHERE excluded.written_at > thread_status_notes.written_at
        RETURNING thread_id`;
      if (written.length === 0) return;
      yield* PubSub.publish(changed, {
        threadId: summary.threadId,
        contextId: summary.contextId,
        note,
      });
    }).pipe(traced("signalbox.thread_status.record", { "thread.id": summary.threadId }));
  };

  const snapshot = Effect.gen(function* () {
    const rows = yield* listedNotes;
    const ids = rows.length === 0 ? [] : yield* contexts.contextIds;
    return {
      _tag: "snapshot",
      notes: rows
        .filter((row) => contextAllows(ids, row.context_id))
        .map((row) => ({ threadId: row.thread_id, note: row.note })),
    } satisfies SignalboxThreadStatusStreamItem;
  });

  /** Subscribed before the snapshot is read, so no note falls between them. */
  const changes: UserThreadStatus["Service"]["changes"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changed);
      const first = yield* snapshot;
      const live = Stream.fromSubscription(subscription).pipe(
        Stream.filterEffect((item) =>
          Effect.map(contexts.contextIds, (ids) => contextAllows(ids, item.contextId)),
        ),
        Stream.map((item): SignalboxThreadStatusStreamItem => ({
          _tag: "note",
          threadId: item.threadId,
          note: item.note,
        })),
      );
      return Stream.concat(Stream.make(first), live);
    }),
  );

  const folderStatus: UserThreadStatus["Service"]["folderStatus"] = (threadId) =>
    Effect.gen(function* () {
      const ids = yield* contexts.contextIds;
      const index = yield* store.threadIndex;
      const all = yield* allNotes;
      return folderStatusAnswer({
        snapshot: yield* folders.snapshot,
        shells: index.threads
          .filter(
            (thread) => contextAllows(ids, thread.contextId) && thread.shell.deletedAt === null,
          )
          .map((thread) => thread.shell),
        notes: new Map(all.map((row) => [row.thread_id, row.note])),
        threadId,
      });
    }).pipe(traced("signalbox.thread_status.folder", { "thread.id": threadId }));

  return UserThreadStatus.of({ recordSummary, changes, folderStatus });
});

export const layer = Layer.effect(UserThreadStatus, make);
