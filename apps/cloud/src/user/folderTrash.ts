import { ThreadId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import { NoteId } from "@t3tools/contracts/signalboxNotes";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const Status = Schema.Literals(["trashed", "restored", "purged"]);
export type Status = typeof Status.Type;

export interface Record {
  readonly trashId: string;
  readonly folderId: FolderId;
  readonly ownerId: SignalboxContextId;
  readonly title: string;
  readonly parentId: FolderId | null;
  readonly position: number;
  readonly folderIds: ReadonlyArray<FolderId>;
  /** Drives directly assigned to folders in this subtree when it was trashed. */
  readonly driveIds: ReadonlyArray<string>;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly noteIds: ReadonlyArray<NoteId>;
  readonly deletedAt: number;
  readonly restoreUntil: number;
  readonly status: Status;
}

const StoredRecord = Schema.Struct({
  trash_id: Schema.String,
  folder_id: FolderId,
  owner_id: SignalboxContextId,
  title: Schema.String,
  parent_id: Schema.NullOr(FolderId),
  position: Schema.Number,
  folder_ids: Schema.String,
  drive_ids: Schema.String,
  thread_ids: Schema.String,
  note_ids: Schema.String,
  deleted_at: Schema.Number,
  restore_until: Schema.Number,
  status: Status,
});

const decodeStoredRecords = Schema.decodeUnknownSync(Schema.Array(StoredRecord));
const decodeFolderIds = Schema.decodeUnknownSync(Schema.Array(FolderId));
const decodeDriveIds = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const decodeThreadIds = Schema.decodeUnknownSync(Schema.Array(ThreadId));
const decodeNoteIds = Schema.decodeUnknownSync(Schema.Array(NoteId));

export const decodeRecords = (rows: ReadonlyArray<unknown>): ReadonlyArray<Record> =>
  decodeStoredRecords(rows).map((row) => ({
    trashId: row.trash_id,
    folderId: row.folder_id,
    ownerId: row.owner_id,
    title: row.title,
    parentId: row.parent_id,
    position: row.position,
    folderIds: decodeFolderIds(JSON.parse(row.folder_ids)),
    driveIds: decodeDriveIds(JSON.parse(row.drive_ids)),
    threadIds: decodeThreadIds(JSON.parse(row.thread_ids)),
    noteIds: decodeNoteIds(JSON.parse(row.note_ids)),
    deletedAt: row.deleted_at,
    restoreUntil: row.restore_until,
    status: row.status,
  }));

/** `UserStore`'s `0021_folder_trash` migration. Rows remain in place for exact restoration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE folders ADD COLUMN trash_id TEXT`;
  yield* sql`ALTER TABLE folders ADD COLUMN trashed_at INTEGER`;
  yield* sql`CREATE INDEX folders_trash_id ON folders (trash_id)`;
  yield* sql`CREATE TABLE folder_trash (
    trash_id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    parent_id TEXT,
    position INTEGER NOT NULL,
    folder_ids TEXT NOT NULL,
    drive_ids TEXT NOT NULL,
    thread_ids TEXT NOT NULL,
    note_ids TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    restore_until INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('trashed', 'restored', 'purged'))
  )`;
  yield* sql`CREATE INDEX folder_trash_status ON folder_trash (status, deleted_at)`;
});
