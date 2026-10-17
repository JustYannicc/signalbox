import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { DriveRemote } from "@signalbox/runner-protocol/DriveProtocol";
import type { DriveCheckpointRecord } from "@signalbox/runner-protocol/DriveProtocol";
import type {
  DriveWriter,
  ThreadRefs,
  RefWrite,
  CheckpointOperationResult,
  ForkCheckpointRequest,
  RestoreCheckpointRequest,
  UndoRestoreRequest,
  UpdateToLatestRequest,
} from "./DriveRevisionTypes.ts";
import { canManageDrive } from "@t3tools/contracts/signalboxDrives";
import * as Migrations from "../storage/migrations.ts";
import { canWrite } from "./driveAccess.ts";
import * as DriveEvents from "./DriveEvents.ts";
import * as DriveMembers from "./DriveMembers.ts";
import * as DriveRevisions from "./DriveRevisions.ts";
import * as DriveRevisionStore from "./DriveRevisionStore.ts";
import { isWithin } from "./DriveReader.ts";
import type { ObjectType, Oid } from "./git/gitObjects.ts";

export type {
  DriveWriter,
  ThreadRefs,
  RefWrite,
  CheckpointOperationResult,
  ForkCheckpointRequest,
  RestoreCheckpointRequest,
  UndoRestoreRequest,
  UpdateToLatestRequest,
} from "./DriveRevisionTypes.ts";

/**
 * What one drive's Durable Object persists: its refs, the packs it holds in
 * R2 and where each object sits in them, the commit graph, and each thread's
 * pinned base and machine generation. Packs are immutable and only added, so
 * an object, once indexed, is readable for good.
 *
 * Refs are `main`, `threads/<thread id>`, `wip/<thread id>` and
 * `machine/<thread id>`. Every write
 * names the thread making it, and the rules for who may move which ref live
 * here, next to the data: a thread moves only its own refs, `main` only by a
 * fast-forward to its own branch while its turn runs, and a machine from an
 * older generation of the thread nothing at all. Every write also needs the
 * thread's owner to still write in the drive (`DriveMembers`).
 *
 * Shortcuts are paths of the drive that show another drive, with its own
 * access and history (#142): a folder split out to be shared stays at its
 * path as a shortcut to its own drive, and anyone who changes the drive can
 * add one to a drive they can open. The drive's own commits never hold files
 * under a shortcut; its threads' machines mount the target there instead.
 *
 * A thread's machine state (#490) is its alone: its packs are private to the
 * thread, listed and leaned on only by that thread, and its `machine` ref is
 * never read, merged or pushed by anything else.
 *
 * Every move of `main` or a thread's branch is also recorded for the drive's
 * people's automations (`DriveEvents`), in the same transaction.
 *
 * A drive backed by a remote repository records it here. Its `main` mirrors
 * the remote's default branch instead (`mirror`), and is never reconciled:
 * the remote is where work lands.
 */

export const MAIN_REF = "main";
export const threadRef = (threadId: string) => `threads/${threadId}`;
export const wipRef = (threadId: string) => `wip/${threadId}`;
export const machineRef = (threadId: string) => `machine/${threadId}`;

export interface PackRegistration {
  readonly name: string;
  readonly size: number;
  readonly threadId: string;
  readonly objects: ReadonlyArray<{
    readonly oid: Oid;
    readonly type: ObjectType;
    readonly offset: number;
    readonly length: number;
    readonly size: number;
  }>;
  readonly commits: ReadonlyArray<StoredCommit>;
  /** Objects outside the pack that it references; the drive must have them all. */
  readonly external: ReadonlyArray<Oid>;
  /** Commits in the pack whose parents stay on the remote (a checked remote head). */
  readonly shallow?: ReadonlyArray<Oid>;
  /** Files the pack's folders name that the remote keeps for the drive (#406), and their sizes when known. */
  readonly promised?: ReadonlyArray<PromisedFile>;
  /** The thread the pack is private to: its machine state (#490). */
  readonly privateTo?: string;
}

/** A file a remote-backed drive leaves on its remote (#406): its id, and its size when known. */
export interface PromisedFile {
  readonly oid: Oid;
  readonly size: number | null;
}

export interface Shortcut {
  readonly path: string;
  readonly target: string;
}

export interface StoredCommit {
  readonly oid: Oid;
  readonly tree: Oid;
  readonly parents: ReadonlyArray<Oid>;
  readonly authorName: string;
  readonly authorEmail: string;
  /** Seconds since the epoch. */
  readonly time: number;
  readonly message: string;
}

/** A thread's latest work in the drive that `main` doesn't hold yet. */
export interface UnreconciledWork {
  readonly threadId: string;
  /** Its latest ref, whichever it moved last: the auto-save or the branch. */
  readonly commit: Oid;
  /** Where the work leaves `main`: their newest shared commit, else the base the thread opened at. */
  readonly base: Oid | null;
  /** When it was saved, in milliseconds since the epoch. */
  readonly at: number;
}

/** Where an object's bytes are: a span of one pack. */
export interface ObjectLocation {
  readonly oid: Oid;
  readonly pack: string;
  readonly offset: number;
  readonly length: number;
  readonly type: ObjectType;
  readonly size: number;
}

export class DriveStore extends Context.Service<
  DriveStore,
  {
    readonly initialize: Effect.Effect<void, SqlError | Migrator.MigrationError>;
    /** A thread's view of the drive. Creates its branch at `main` and pins its base the first time. */
    readonly open: (writer: DriveWriter) => Effect.Effect<RefWrite, SqlError>;
    readonly refs: (
      threadId: string | null,
      packsAfter?: number,
    ) => Effect.Effect<ThreadRefs, SqlError>;
    readonly ref: (name: string) => Effect.Effect<Oid | null, SqlError>;
    /**
     * Which of `oids` the drive does not have in packs `visibleTo` is handed:
     * public packs for `null`, and a thread's own private ones for its id.
     */
    readonly missing: (
      oids: ReadonlyArray<Oid>,
      visibleTo: string | null,
    ) => Effect.Effect<ReadonlyArray<Oid>, SqlError>;
    /** Which of `oids` the remote keeps for the drive (#406). */
    readonly promised: (
      oids: ReadonlyArray<Oid>,
    ) => Effect.Effect<ReadonlyArray<PromisedFile>, SqlError>;
    /** Indexes a pack already stored in R2. Idempotent. Fails when it references objects the drive lacks. */
    readonly registerPack: (
      pack: PackRegistration,
    ) => Effect.Effect<
      { readonly _tag: "ok" } | { readonly _tag: "missing"; readonly oids: ReadonlyArray<Oid> },
      SqlError
    >;
    readonly updateRefs: (
      writer: DriveWriter,
      updates: ReadonlyArray<{
        readonly name: string;
        readonly old: Oid | null;
        readonly new: Oid;
      }>,
    ) => Effect.Effect<RefWrite, SqlError>;
    readonly reconcile: (
      writer: DriveWriter,
      request: { readonly expectedMain: Oid | null; readonly newMain: Oid },
    ) => Effect.Effect<RefWrite, SqlError>;
    /** Backs the drive by a remote repository. Its repository and default branch may change. */
    readonly setRemote: (remote: DriveRemote) => Effect.Effect<void, SqlError>;
    readonly remote: Effect.Effect<DriveRemote | null, SqlError>;
    /**
     * Moves a remote-backed drive's `main` to the remote's head, which the
     * caller has checked against the remote. Only while the writer's turn
     * runs, and only from the `main` it last saw.
     */
    readonly mirror: (
      writer: DriveWriter,
      request: { readonly expectedMain: Oid | null; readonly newMain: Oid },
    ) => Effect.Effect<RefWrite, SqlError>;
    readonly locate: (
      oids: ReadonlyArray<Oid>,
    ) => Effect.Effect<ReadonlyArray<ObjectLocation>, SqlError>;
    /** The object starting at `offset` in `pack`: how an `ofs_delta` finds its base. */
    readonly locateAt: (
      pack: string,
      offset: number,
    ) => Effect.Effect<ObjectLocation | null, SqlError>;
    readonly commits: (
      oids: ReadonlyArray<Oid>,
    ) => Effect.Effect<ReadonlyArray<StoredCommit>, SqlError>;
    /** Commits `to` reaches and `from` (null: nothing) doesn't, newest first. */
    readonly commitsBetween: (
      from: Oid | null,
      to: Oid,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<StoredCommit>, SqlError>;
    /** Commits reachable from `from`, newest first. */
    readonly log: (
      from: Oid,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<StoredCommit>, SqlError>;
    /**
     * Moves `main` for a person rather than a thread, if they manage the drive:
     * to start it, or to split a folder out and leave `shortcut` in its place.
     * A fast-forward only, compared and set like a thread's reconcile.
     */
    readonly replaceMain: (
      userId: string,
      request: {
        readonly expectedMain: Oid | null;
        readonly newMain: Oid;
        readonly shortcut?: Shortcut;
      },
    ) => Effect.Effect<RefWrite, SqlError>;
    readonly shortcuts: Effect.Effect<ReadonlyArray<Shortcut>, SqlError>;
    /**
     * Adds a shortcut for a person who can change the drive's files. Refused
     * when its path is taken by another shortcut, or is inside one or holds one.
     */
    readonly addShortcut: (
      userId: string,
      shortcut: Shortcut,
    ) => Effect.Effect<ShortcutChange, SqlError>;
    /** Removes the shortcut at `path`, for a person who can change the drive's files. */
    readonly removeShortcut: (
      userId: string,
      path: string,
    ) => Effect.Effect<ShortcutChange, SqlError>;
    /** The `limit` most recently saved pieces of work `main` doesn't hold, newest first; or just `threadId`'s. */
    readonly unreconciled: (input: {
      readonly limit: number;
      readonly threadId?: string;
    }) => Effect.Effect<ReadonlyArray<UnreconciledWork>, SqlError>;
    /** Records an immutable checkpoint and its private note ref after all objects are in public packs. */
    readonly recordCheckpoint: (
      writer: DriveWriter,
      record: DriveCheckpointRecord,
    ) => Effect.Effect<RefWrite, SqlError>;
    /** Reads a thread's retained checkpoint, independent of its current branch. */
    readonly checkpoint: (
      threadId: string,
      runId: string,
    ) => Effect.Effect<DriveCheckpointRecord | null, SqlError>;
    /** Starts a new thread at an exact retained checkpoint with an immutable retry receipt. */
    readonly forkCheckpoint: (
      userId: string,
      request: ForkCheckpointRequest,
    ) => Effect.Effect<CheckpointOperationResult, SqlError>;
    /**
     * Restores branch and autosave to a retained checkpoint, fencing older machines.
     * The caller stops the active Runner first; this advances generation so any
     * subsequent write from the stopped Runner is refused. The next Runner uses
     * the generation returned with the operation result.
     */
    readonly restoreCheckpoint: (
      userId: string,
      request: RestoreCheckpointRequest,
    ) => Effect.Effect<CheckpointOperationResult, SqlError>;
    /**
     * Reverses one successful restore while preserving current refs under private refs.
     * The next Runner must use the generation returned here.
     */
    readonly undoRestore: (
      userId: string,
      request: UndoRestoreRequest,
    ) => Effect.Effect<CheckpointOperationResult, SqlError>;
    /**
     * Explicitly drops a thread's historical input-view pins. The caller stops
     * the active Runner first; this advances generation so it reloads current inputs.
     */
    readonly updateToLatest: (
      userId: string,
      request: UpdateToLatestRequest,
    ) => Effect.Effect<CheckpointOperationResult, SqlError>;
  }
>()("@signalbox/cloud/drive/DriveStore") {}

/** Whether one of two paths is the other or inside it. */
const overlaps = (a: string, b: string) => isWithin(a, b) || isWithin(b, a);

export type ShortcutChange =
  | { readonly _tag: "ok" }
  | { readonly _tag: "refused"; readonly reason: string };

const migrations = Migrator.fromRecord({
  "0001_drive": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE refs (
      name TEXT PRIMARY KEY,
      oid TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE packs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      object_count INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE objects (
      oid TEXT PRIMARY KEY,
      pack_seq INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      length INTEGER NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL
    )`;
    // Every object of every pack by position, duplicates included: an `ofs_delta`
    // names its base by offset in its own pack, even when `objects` points elsewhere.
    yield* sql`CREATE TABLE pack_entries (
      pack_seq INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      oid TEXT NOT NULL,
      length INTEGER NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      PRIMARY KEY (pack_seq, offset)
    )`;
    yield* sql`CREATE TABLE commits (
      oid TEXT PRIMARY KEY,
      tree TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      time INTEGER NOT NULL,
      message TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE commit_parents (
      oid TEXT NOT NULL,
      position INTEGER NOT NULL,
      parent TEXT NOT NULL,
      PRIMARY KEY (oid, position)
    )`;
    yield* sql`CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      base TEXT,
      generation INTEGER NOT NULL,
      opened_at INTEGER NOT NULL
    )`;
  }),
  "0002_access": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* DriveMembers.createTables;
    yield* sql`CREATE TABLE shortcuts (
      path TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
  }),
  "0003_remote": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE remote (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL,
      repository TEXT NOT NULL,
      default_branch TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE shallow (
      oid TEXT PRIMARY KEY,
      pack_seq INTEGER NOT NULL
    )`;
  }),
  // Files a remote-backed drive's folders name that the remote keeps (#406).
  "0004_promised": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE promised (
      oid TEXT PRIMARY KEY,
      size INTEGER
    )`;
  }),
  // Packs private to one thread: its machine state (#490). Which packs hold an object
  // decides whether a pack may lean on it, so entries are found by object too.
  "0005_private_packs": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE packs ADD COLUMN private_to TEXT`;
    yield* sql`CREATE INDEX pack_entries_oid ON pack_entries (oid)`;
  }),
  // Moves of `main` and threads' branches, for automations (#471).
  "0006_ref_events": DriveEvents.createTables,
  // Immutable turn checkpoints and idempotent fork/restore receipts (#498).
  "0007_drive_revisions": DriveRevisions.createTables,
  // Undo snapshots for restores already tracked by 0007.
  "0008_drive_restore_snapshots": DriveRevisions.createRestoreTables,
  "0009_ref_deletions": DriveEvents.allowDeletedRefs,
});

/** Applies every migration not recorded yet (`storage/migrations.ts`). Never edit or rename a merged one. */
const migrate = Migrations.run(migrations);

const RefRow = Schema.Struct({ name: Schema.String, oid: Schema.String });
const PackRow = Schema.Struct({ seq: Schema.Number, name: Schema.String, size: Schema.Number });
const decodeOwnerRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ private_to: Schema.NullOr(Schema.String) })),
);
const RemoteRow = Schema.Struct({
  provider: DriveRemote.fields.provider,
  repository: Schema.String,
  default_branch: Schema.String,
});
const ObjectTypeSchema = Schema.Literals(["commit", "tree", "blob", "tag"]);
const LocationRow = Schema.Struct({
  oid: Schema.String,
  pack: Schema.String,
  offset: Schema.Number,
  length: Schema.Number,
  type: ObjectTypeSchema,
  size: Schema.Number,
});
const CommitRow = Schema.Struct({
  oid: Schema.String,
  tree: Schema.String,
  author_name: Schema.String,
  author_email: Schema.String,
  time: Schema.Number,
  message: Schema.String,
  parents: Schema.NullOr(Schema.String),
});
const decodeRefRows = Schema.decodeUnknownSync(Schema.Array(RefRow));
const decodePackRows = Schema.decodeUnknownSync(Schema.Array(PackRow));
const decodeThreadRows = Schema.decodeUnknownSync(Schema.Array(DriveRevisions.ThreadRevisionRow));
const decodeRemoteRows = Schema.decodeUnknownSync(Schema.Array(RemoteRow));
const decodeLocationRows = Schema.decodeUnknownSync(Schema.Array(LocationRow));
const decodeCommitRows = Schema.decodeUnknownSync(Schema.Array(CommitRow));
const decodeShortcutRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ path: Schema.String, target: Schema.String })),
);
const OidRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ oid: Schema.String })));
const PromisedRow = Schema.Struct({ oid: Schema.String, size: Schema.NullOr(Schema.Number) });
const decodePromisedRows = Schema.decodeUnknownSync(Schema.Array(PromisedRow));
const encodePromised = Schema.encodeSync(Schema.fromJsonString(Schema.Array(PromisedRow)));
const decodeWorkRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      thread_id: Schema.String,
      base: Schema.NullOr(Schema.String),
      head: Schema.String,
      at: Schema.Number,
    }),
  ),
);

const toCommit = (row: typeof CommitRow.Type): StoredCommit => ({
  oid: row.oid,
  tree: row.tree,
  // `group_concat` in position order.
  parents: row.parents === null || row.parents === "" ? [] : row.parents.split(","),
  authorName: row.author_name,
  authorEmail: row.author_email,
  time: row.time,
  message: row.message,
});

/** SQLite caps bound parameters per statement; long id lists go in chunks. */
const CHUNK = 90;
const chunks = <A>(items: ReadonlyArray<A>) =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) =>
    items.slice(i * CHUNK, (i + 1) * CHUNK),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const members = yield* DriveMembers.DriveMembers;
  const events = yield* DriveEvents.DriveEvents;

  const storedRef = (name: string) =>
    sql`SELECT name, oid FROM refs WHERE name = ${name}`.pipe(
      Effect.map((rows) => decodeRefRows(rows)[0]?.oid ?? null),
    );
  // Checkpoint and notes refs are durable internal refs, never advertised as
  // browseable drive refs or handed to a machine for push.
  const ref: DriveStore["Service"]["ref"] = (name) =>
    name.startsWith("signalbox/") ? Effect.succeed(null) : storedRef(name);

  const threadRow = (threadId: string) =>
    sql`SELECT base, generation, notes_oid, pinned_views, revision
      FROM threads WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => decodeThreadRows(rows)[0] ?? null),
    );

  const remote: DriveStore["Service"]["remote"] =
    sql`SELECT provider, repository, default_branch FROM remote WHERE id = 1`.pipe(
      Effect.map((rows) => {
        const row = decodeRemoteRows(rows)[0];
        return row === undefined
          ? null
          : {
              provider: row.provider,
              repository: row.repository,
              defaultBranch: row.default_branch,
            };
      }),
    );

  const setRemote: DriveStore["Service"]["setRemote"] = (next) =>
    sql`INSERT INTO remote (id, provider, repository, default_branch)
      VALUES (1, ${next.provider}, ${next.repository}, ${next.defaultBranch})
      ON CONFLICT (id) DO UPDATE SET provider = excluded.provider,
        repository = excluded.repository, default_branch = excluded.default_branch`.pipe(
      Effect.asVoid,
    );

  const refs: DriveStore["Service"]["refs"] = (threadId, packsAfter = 0) =>
    Effect.gen(function* () {
      const packs = decodePackRows(
        yield* sql`SELECT seq, name, size FROM packs WHERE seq > ${packsAfter}
          AND (private_to IS NULL OR private_to = ${threadId}) ORDER BY seq`,
      );
      const thread = threadId === null ? null : yield* threadRow(threadId);
      const shallow = OidRows(
        yield* sql`SELECT oid FROM shallow WHERE pack_seq > ${packsAfter} ORDER BY pack_seq, oid`,
      ).map((row) => row.oid);
      return {
        main: yield* ref(MAIN_REF),
        thread: threadId === null ? null : yield* ref(threadRef(threadId)),
        wip: threadId === null ? null : yield* ref(wipRef(threadId)),
        machine: threadId === null ? null : yield* ref(machineRef(threadId)),
        base: thread?.base ?? null,
        packs,
        remote: yield* remote,
        shallow,
        notes: thread?.notes_oid ?? null,
        pinnedViews:
          thread?.pinned_views == null ? null : DriveRevisions.decodeViews(thread.pinned_views),
        revision: thread?.revision ?? null,
      };
    });

  const isCommit = (oid: Oid) =>
    sql`SELECT oid FROM commits WHERE oid = ${oid}`.pipe(Effect.map((rows) => rows.length > 0));

  const setRef = (name: string, oid: Oid, by: string) =>
    Effect.flatMap(
      Clock.currentTimeMillis,
      (now) =>
        sql`INSERT INTO refs (name, oid, updated_by, updated_at) VALUES (${name}, ${oid}, ${by}, ${now})
          ON CONFLICT (name) DO UPDATE SET oid = excluded.oid, updated_by = excluded.updated_by,
          updated_at = excluded.updated_at`,
    ).pipe(Effect.asVoid);

  /** Moves `main` or a thread's branch from `before` for a thread or a person, recording it when it changed. */
  const land = (
    name: string,
    before: Oid | null,
    after: Oid | null,
    by: { readonly threadId: string } | { readonly userId: string },
  ) => {
    const threadId = "threadId" in by ? by.threadId : null;
    const move =
      after === null
        ? sql`DELETE FROM refs WHERE name = ${name}`.pipe(Effect.asVoid)
        : setRef(name, after, "threadId" in by ? by.threadId : by.userId);
    return move.pipe(
      Effect.andThen(
        before === after ? Effect.void : events.record({ ref: name, before, after, threadId }),
      ),
    );
  };

  /**
   * Records the writer's generation, refusing an older one: once a thread's
   * newer machine has written, its earlier machine never writes again.
   */
  const fence = (writer: DriveWriter) =>
    Effect.gen(function* () {
      const row = yield* threadRow(writer.threadId);
      if (row !== null && writer.generation < row.generation) return false;
      if (row !== null && writer.generation > row.generation) {
        yield* sql`UPDATE threads SET generation = ${writer.generation}
          WHERE thread_id = ${writer.threadId}`;
      }
      return true;
    });

  const STALE: RefWrite = {
    _tag: "refused",
    reason: "A newer machine of this thread writes here now.",
  };

  /** Whether the writer's owner may still change files here. Removing them ends it at once. */
  const writes = (writer: DriveWriter) => Effect.map(members.role(writer.userId), canWrite);

  const NO_ACCESS_REASON = "You no longer have access to change this drive.";
  const NO_ACCESS: RefWrite = {
    _tag: "refused",
    reason: NO_ACCESS_REASON,
  };

  const open: DriveStore["Service"]["open"] = (writer) =>
    Effect.gen(function* () {
      if (!(yield* writes(writer))) return NO_ACCESS;
      if (!(yield* fence(writer))) return STALE;
      if ((yield* threadRow(writer.threadId)) === null) {
        const main = yield* ref(MAIN_REF);
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO threads (thread_id, base, generation, opened_at)
          VALUES (${writer.threadId}, ${main}, ${writer.generation}, ${now})`;
        if (main !== null) yield* setRef(threadRef(writer.threadId), main, writer.threadId);
      }
      return {
        _tag: "ok",
        refs: yield* refs(writer.threadId, writer.packsAfter),
      } satisfies RefWrite;
    }).pipe(sql.withTransaction);

  /** What the drive neither holds nor has the remote keep for it. */
  const missing: DriveStore["Service"]["missing"] = (oids, visibleTo) =>
    Effect.gen(function* () {
      const unique = [...new Set(oids)];
      const found = new Set<string>();
      for (const chunk of chunks(unique)) {
        // Two queries: one with both lists would bind twice the parameters SQLite allows.
        // Where each object is read from, usually a pack the caller may lean on.
        for (const row of OidRows(
          yield* sql`SELECT o.oid FROM objects o JOIN packs p ON p.seq = o.pack_seq
            WHERE o.oid IN ${sql.in(chunk)}
            AND (p.private_to IS NULL OR p.private_to = ${visibleTo})`,
        ))
          found.add(row.oid);
        // Else another copy may be in one: an object first stored privately is read from there.
        const unread = chunk.filter((oid) => !found.has(oid));
        if (unread.length > 0) {
          for (const row of OidRows(
            yield* sql`SELECT DISTINCT e.oid FROM pack_entries e JOIN packs p ON p.seq = e.pack_seq
              WHERE e.oid IN ${sql.in(unread)}
              AND (p.private_to IS NULL OR p.private_to = ${visibleTo})`,
          ))
            found.add(row.oid);
        }
        const rest = chunk.filter((oid) => !found.has(oid));
        if (rest.length === 0) continue;
        for (const row of OidRows(
          yield* sql`SELECT oid FROM promised WHERE oid IN ${sql.in(rest)}`,
        ))
          found.add(row.oid);
      }
      return unique.filter((oid) => !found.has(oid));
    });

  const promised: DriveStore["Service"]["promised"] = (oids) =>
    Effect.gen(function* () {
      const out: Array<PromisedFile> = [];
      for (const chunk of chunks([...new Set(oids)])) {
        out.push(
          ...decodePromisedRows(
            yield* sql`SELECT oid, size FROM promised WHERE oid IN ${sql.in(chunk)}`,
          ),
        );
      }
      return out;
    });

  const registerPack: DriveStore["Service"]["registerPack"] = (pack) =>
    Effect.gen(function* () {
      const existing = decodeOwnerRows(
        yield* sql`SELECT private_to FROM packs WHERE name = ${pack.name}`,
      );
      const privateTo = pack.privateTo ?? null;
      if (existing.length > 0) {
        // The same bytes again: a retry, or a copy of a pack the uploader can already lean on.
        const owner = existing[0]!.private_to;
        if (owner === privateTo || owner === null) return { _tag: "ok" } as const;
        // Another thread's private pack stays its own.
        if (privateTo !== null) return { _tag: "missing", oids: [] } as const;
        // A public copy of a private pack, its uploader holding the bytes itself: public
        // once everything it leans on is.
        const absent = yield* missing(pack.external, null);
        if (absent.length > 0) return { _tag: "missing", oids: absent } as const;
        yield* sql`UPDATE packs SET private_to = NULL WHERE name = ${pack.name}`;
        return { _tag: "ok" } as const;
      }
      const promising = new Set((pack.promised ?? []).map((file) => file.oid));
      // A public pack leans only on public packs; a private one on those and its thread's own.
      const absent = (yield* missing(pack.external, privateTo)).filter(
        (oid) => !promising.has(oid),
      );
      if (absent.length > 0) return { _tag: "missing", oids: absent } as const;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO packs (name, size, object_count, thread_id, created_at, private_to)
        VALUES (${pack.name}, ${pack.size}, ${pack.objects.length}, ${pack.threadId}, ${now}, ${privateTo})`;
      const [row] = yield* sql<{
        readonly seq: number;
      }>`SELECT seq FROM packs WHERE name = ${pack.name}`;
      const seq = row!.seq;
      for (const object of pack.objects) {
        // An object already in an earlier pack is still read from there.
        yield* sql`INSERT OR IGNORE INTO objects (oid, pack_seq, offset, length, type, size)
          VALUES (${object.oid}, ${seq}, ${object.offset}, ${object.length}, ${object.type}, ${object.size})`;
        yield* sql`INSERT INTO pack_entries (pack_seq, offset, oid, length, type, size)
          VALUES (${seq}, ${object.offset}, ${object.oid}, ${object.length}, ${object.type}, ${object.size})`;
      }
      for (const oid of pack.shallow ?? []) {
        yield* sql`INSERT OR IGNORE INTO shallow (oid, pack_seq) VALUES (${oid}, ${seq})`;
      }
      // One statement however many: a big remote names hundreds of thousands of files.
      if (pack.promised !== undefined && pack.promised.length > 0) {
        yield* sql`INSERT OR IGNORE INTO promised (oid, size)
          SELECT value ->> 'oid', value ->> 'size' FROM json_each(${encodePromised(pack.promised)})`;
      }
      for (const commit of pack.commits) {
        yield* sql`INSERT OR IGNORE INTO commits (oid, tree, author_name, author_email, time, message)
          VALUES (${commit.oid}, ${commit.tree}, ${commit.authorName}, ${commit.authorEmail},
            ${commit.time}, ${commit.message})`;
        for (const [position, parent] of commit.parents.entries()) {
          yield* sql`INSERT OR IGNORE INTO commit_parents (oid, position, parent)
            VALUES (${commit.oid}, ${position}, ${parent})`;
        }
      }
      return { _tag: "ok" } as const;
    }).pipe(sql.withTransaction);

  const isAncestor = (ancestor: Oid, descendant: Oid) =>
    sql`WITH RECURSIVE reach(oid) AS (
        SELECT ${descendant}
        UNION
        SELECT p.parent FROM commit_parents p JOIN reach r ON p.oid = r.oid
      )
      SELECT oid FROM reach WHERE oid = ${ancestor} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  const ownRefs = (threadId: string) =>
    new Set([threadRef(threadId), wipRef(threadId), machineRef(threadId)]);

  const updateRefs: DriveStore["Service"]["updateRefs"] = (writer, updates) =>
    Effect.gen(function* () {
      const own = ownRefs(writer.threadId);
      const foreign = updates.find((update) => !own.has(update.name));
      if (foreign !== undefined) {
        return {
          _tag: "refused",
          reason: `A thread moves only its own refs, not ${foreign.name}.`,
        } as const;
      }
      if (!(yield* writes(writer))) return NO_ACCESS;
      if (!(yield* fence(writer))) return STALE;
      for (const update of updates) {
        // Only the machine ref may name a commit other threads aren't handed.
        const visible =
          update.name === machineRef(writer.threadId)
            ? yield* isCommit(update.new)
            : (yield* missing([update.new], null)).length === 0;
        if (!visible) {
          return {
            _tag: "refused",
            reason: `The drive does not have commit ${update.new}.`,
          } as const;
        }
      }
      const currents = new Map<string, Oid | null>();
      for (const update of updates) {
        const current = yield* ref(update.name);
        // Already where the writer wants it: a retry of a write that landed.
        if (current !== update.old && current !== update.new) {
          return {
            _tag: "conflict",
            refs: yield* refs(writer.threadId, writer.packsAfter),
          } as const;
        }
        currents.set(update.name, current);
      }
      const branch = threadRef(writer.threadId);
      for (const update of updates) {
        yield* update.name === branch
          ? land(branch, currents.get(branch) ?? null, update.new, writer)
          : setRef(update.name, update.new, writer.threadId);
      }
      return { _tag: "ok", refs: yield* refs(writer.threadId, writer.packsAfter) } as const;
    }).pipe(sql.withTransaction);

  const reconcile: DriveStore["Service"]["reconcile"] = (writer, request) =>
    Effect.gen(function* () {
      if (!writer.live) {
        return {
          _tag: "refused",
          reason: "main only moves while the thread's turn runs.",
        } as const;
      }
      if (!(yield* writes(writer))) return NO_ACCESS;
      if ((yield* remote) !== null) {
        return { _tag: "refused", reason: "This drive's work lands on its remote." } as const;
      }
      if (!(yield* fence(writer))) return STALE;
      if ((yield* ref(threadRef(writer.threadId))) !== request.newMain) {
        return { _tag: "refused", reason: "main only moves to the thread's own branch." } as const;
      }
      const current = yield* ref(MAIN_REF);
      if (current === request.newMain)
        return { _tag: "ok", refs: yield* refs(writer.threadId, writer.packsAfter) } as const;
      if (current !== request.expectedMain) {
        return { _tag: "conflict", refs: yield* refs(writer.threadId, writer.packsAfter) } as const;
      }
      if (current !== null && !(yield* isAncestor(current, request.newMain))) {
        return { _tag: "refused", reason: "main only moves forward: merge it first." } as const;
      }
      yield* land(MAIN_REF, current, request.newMain, writer);
      return { _tag: "ok", refs: yield* refs(writer.threadId, writer.packsAfter) } as const;
    }).pipe(sql.withTransaction);

  const mirror: DriveStore["Service"]["mirror"] = (writer, request) =>
    Effect.gen(function* () {
      if (!writer.live) {
        return {
          _tag: "refused",
          reason: "main only moves while the thread's turn runs.",
        } as const;
      }
      if ((yield* remote) === null) {
        return { _tag: "refused", reason: "This drive has no remote to mirror." } as const;
      }
      if (!(yield* writes(writer))) return NO_ACCESS;
      if (!(yield* fence(writer))) return STALE;
      if (!(yield* isCommit(request.newMain))) {
        return {
          _tag: "refused",
          reason: `The drive does not have commit ${request.newMain}.`,
        } as const;
      }
      const current = yield* ref(MAIN_REF);
      if (current !== request.newMain) {
        // The remote may have been force-pushed, so main need not move forward.
        if (current !== request.expectedMain) {
          return {
            _tag: "conflict",
            refs: yield* refs(writer.threadId, writer.packsAfter),
          } as const;
        }
        yield* land(MAIN_REF, current, request.newMain, writer);
      }
      return { _tag: "ok", refs: yield* refs(writer.threadId, writer.packsAfter) } as const;
    }).pipe(sql.withTransaction);

  const locate: DriveStore["Service"]["locate"] = (oids) =>
    Effect.gen(function* () {
      const out: Array<ObjectLocation> = [];
      for (const chunk of chunks([...new Set(oids)])) {
        out.push(
          ...decodeLocationRows(
            yield* sql`SELECT o.oid, p.name AS pack, o.offset, o.length, o.type, o.size
              FROM objects o JOIN packs p ON p.seq = o.pack_seq WHERE o.oid IN ${sql.in(chunk)}`,
          ),
        );
      }
      return out;
    });

  const locateAt: DriveStore["Service"]["locateAt"] = (pack, offset) =>
    sql`SELECT e.oid, p.name AS pack, e.offset, e.length, e.type, e.size
      FROM pack_entries e JOIN packs p ON p.seq = e.pack_seq
      WHERE p.name = ${pack} AND e.offset = ${offset}`.pipe(
      Effect.map((rows) => decodeLocationRows(rows)[0] ?? null),
    );

  const COMMIT_COLUMNS = sql`c.oid, c.tree, c.author_name, c.author_email, c.time, c.message,
    (SELECT group_concat(parent, ',') FROM
      (SELECT parent FROM commit_parents WHERE oid = c.oid ORDER BY position)) AS parents`;

  const commits: DriveStore["Service"]["commits"] = (oids) =>
    Effect.gen(function* () {
      const out: Array<StoredCommit> = [];
      for (const chunk of chunks([...new Set(oids)])) {
        const rows =
          yield* sql`SELECT ${COMMIT_COLUMNS} FROM commits c WHERE c.oid IN ${sql.in(chunk)}`;
        out.push(...decodeCommitRows(rows).map(toCommit));
      }
      return out;
    });

  const commitsBetween: DriveStore["Service"]["commitsBetween"] = (from, to, limit) =>
    sql`WITH RECURSIVE old(oid) AS (
        SELECT ${from} WHERE ${from} IS NOT NULL
        UNION
        SELECT p.parent FROM commit_parents p JOIN old o ON p.oid = o.oid
      ),
      new(oid) AS (
        SELECT ${to}
        UNION
        SELECT p.parent FROM commit_parents p JOIN new n ON p.oid = n.oid
        WHERE n.oid NOT IN (SELECT oid FROM old)
      )
      SELECT ${COMMIT_COLUMNS} FROM commits c JOIN new n ON n.oid = c.oid
      WHERE c.oid NOT IN (SELECT oid FROM old)
      ORDER BY c.time DESC, c.oid LIMIT ${limit}`.pipe(
      Effect.map((rows) => decodeCommitRows(rows).map(toCommit)),
    );

  const log: DriveStore["Service"]["log"] = (from, limit) =>
    sql`WITH RECURSIVE reach(oid) AS (
        SELECT ${from}
        UNION
        SELECT p.parent FROM commit_parents p JOIN reach r ON p.oid = r.oid
      )
      SELECT ${COMMIT_COLUMNS} FROM commits c JOIN reach r ON r.oid = c.oid
      ORDER BY c.time DESC, c.oid LIMIT ${limit}`.pipe(
      Effect.map((rows) => decodeCommitRows(rows).map(toCommit)),
    );

  const replaceMain: DriveStore["Service"]["replaceMain"] = (userId, request) =>
    Effect.gen(function* () {
      if (!canManageDrive(yield* members.role(userId))) {
        return { _tag: "refused", reason: "Only the drive's managers can do that." } as const;
      }
      if (!(yield* isCommit(request.newMain))) {
        return {
          _tag: "refused",
          reason: `The drive does not have commit ${request.newMain}.`,
        } as const;
      }
      const current = yield* ref(MAIN_REF);
      if (current !== request.newMain) {
        if (current !== request.expectedMain) {
          return { _tag: "conflict", refs: yield* refs(null) } as const;
        }
        if (current !== null && !(yield* isAncestor(current, request.newMain))) {
          return { _tag: "refused", reason: "main only moves forward." } as const;
        }
        yield* land(MAIN_REF, current, request.newMain, { userId });
      }
      if (request.shortcut !== undefined) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO shortcuts (path, target, created_at)
          VALUES (${request.shortcut.path}, ${request.shortcut.target}, ${now})
          ON CONFLICT (path) DO NOTHING`;
      }
      return { _tag: "ok", refs: yield* refs(null) } as const;
    }).pipe(sql.withTransaction);

  const shortcuts: DriveStore["Service"]["shortcuts"] = sql`SELECT path, target FROM shortcuts
    ORDER BY path`.pipe(Effect.map(decodeShortcutRows));

  const refuseShortcut = (reason: string) => Effect.succeed({ _tag: "refused", reason } as const);
  const NOT_A_WRITER = "You can't change this drive.";

  const addShortcut: DriveStore["Service"]["addShortcut"] = (userId, shortcut) =>
    Effect.gen(function* () {
      if (!canWrite(yield* members.role(userId))) return yield* refuseShortcut(NOT_A_WRITER);
      const clash = (yield* shortcuts).find((existing) => overlaps(existing.path, shortcut.path));
      if (clash !== undefined) {
        return yield* refuseShortcut(
          clash.path === shortcut.path
            ? `${shortcut.path} is already a shortcut.`
            : `${shortcut.path} would overlap the shortcut at ${clash.path}.`,
        );
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO shortcuts (path, target, created_at)
        VALUES (${shortcut.path}, ${shortcut.target}, ${now})`;
      return { _tag: "ok" } as const;
    }).pipe(sql.withTransaction);

  const removeShortcut: DriveStore["Service"]["removeShortcut"] = (userId, path) =>
    Effect.gen(function* () {
      if (!canWrite(yield* members.role(userId))) return yield* refuseShortcut(NOT_A_WRITER);
      const removed = yield* sql`DELETE FROM shortcuts WHERE path = ${path} RETURNING path`;
      return removed.length === 0
        ? yield* refuseShortcut(`${path} isn't a shortcut.`)
        : ({ _tag: "ok" } as const);
    }).pipe(sql.withTransaction);

  const revisionOperations = DriveRevisionStore.makeOperations({
    sql,
    role: members.role,
    threadRow,
    refs,
    ref,
    publicCommit: (oid) =>
      Effect.gen(function* () {
        if (!(yield* isCommit(oid))) return false;
        return (yield* missing([oid], null)).length === 0;
      }),
    threadRef,
    wipRef,
    setRef,
    land,
    removeRef: (name) => sql`DELETE FROM refs WHERE name = ${name}`.pipe(Effect.asVoid),
    internalRef: storedRef,
    fence,
  });

  /** Every commit `main` reaches, as a recursive CTE to join against. */
  const REACH = sql`reach(oid) AS (
      SELECT oid FROM refs WHERE name = ${MAIN_REF}
      UNION
      SELECT p.parent FROM commit_parents p JOIN reach r ON p.oid = r.oid
    )`;

  const unreconciled: DriveStore["Service"]["unreconciled"] = ({ limit, threadId }) =>
    Effect.gen(function* () {
      const moved = sql`(b.oid IS NOT NULL OR w.oid IS NOT NULL)`;
      // Each thread's latest ref, whichever it moved last, unless `main` already holds it.
      const rows = decodeWorkRows(
        yield* sql`WITH RECURSIVE ${REACH},
          heads AS (
            SELECT t.thread_id, t.base,
              CASE WHEN w.oid IS NOT NULL AND (b.oid IS NULL OR w.updated_at >= b.updated_at)
                THEN w.oid ELSE b.oid END AS head,
              max(coalesce(b.updated_at, 0), coalesce(w.updated_at, 0)) AS at
            FROM threads t
            LEFT JOIN refs b ON b.name = 'threads/' || t.thread_id
            LEFT JOIN refs w ON w.name = 'wip/' || t.thread_id
            WHERE ${sql.and(threadId === undefined ? [moved] : [moved, sql`t.thread_id = ${threadId}`])}
          )
          SELECT thread_id, base, head, at FROM heads
          WHERE head NOT IN (SELECT oid FROM reach)
          ORDER BY at DESC LIMIT ${limit}`,
      );
      // Where the work leaves `main`: its newest ancestor `main` holds, so files
      // other threads landed (and this one merged in) aren't counted as its own.
      return yield* Effect.forEach(rows, (row) =>
        Effect.map(
          sql`WITH RECURSIVE ${REACH},
            up(oid) AS (
              SELECT ${row.head}
              UNION
              SELECT p.parent FROM commit_parents p JOIN up u ON p.oid = u.oid
              WHERE u.oid NOT IN (SELECT oid FROM reach)
            )
            SELECT c.oid FROM up JOIN commits c ON c.oid = up.oid
            WHERE up.oid IN (SELECT oid FROM reach) ORDER BY c.time DESC LIMIT 1`,
          (found): UnreconciledWork => ({
            threadId: row.thread_id,
            commit: row.head,
            base: OidRows(found)[0]?.oid ?? row.base,
            at: row.at,
          }),
        ),
      );
    });

  return DriveStore.of({
    initialize: Effect.asVoid(migrate.pipe(Effect.provideService(SqlClient.SqlClient, sql))),
    open,
    refs,
    ref,
    missing,
    promised,
    registerPack,
    updateRefs,
    reconcile,
    setRemote,
    remote,
    mirror,
    locate,
    locateAt,
    commits,
    commitsBetween,
    log,
    replaceMain,
    shortcuts,
    addShortcut,
    removeShortcut,
    unreconciled,
    ...revisionOperations,
  });
});

/** The store, its events and the members of the drive named `driveId`, on the object's SQLite. */
export const layer = (driveId: string) =>
  Layer.effect(DriveStore, make).pipe(
    Layer.provideMerge(DriveEvents.layer(driveId)),
    Layer.provideMerge(DriveMembers.layer(driveId)),
  );
