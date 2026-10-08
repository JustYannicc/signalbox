import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { DriveRemote } from "@signalbox/runner-protocol/DriveProtocol";
import { canManageDrive } from "@t3tools/contracts/signalboxDrives";
import { canWrite } from "./driveAccess.ts";
import * as DriveMembers from "./DriveMembers.ts";
import { isWithin } from "./DriveReader.ts";
import type { ObjectType, Oid } from "./git/gitObjects.ts";

/**
 * What one drive's Durable Object persists: its refs, the packs it holds in
 * R2 and where each object sits in them, the commit graph, and each thread's
 * pinned base and machine generation. Packs are immutable and only added, so
 * an object, once indexed, is readable for good.
 *
 * Refs are `main`, `threads/<thread id>` and `wip/<thread id>`. Every write
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
 * A drive backed by a remote repository records it here. Its `main` mirrors
 * the remote's default branch instead (`mirror`), and is never reconciled:
 * the remote is where work lands.
 */

export const MAIN_REF = "main";
export const threadRef = (threadId: string) => `threads/${threadId}`;
export const wipRef = (threadId: string) => `wip/${threadId}`;

/** Who is writing: a thread, on its machine of `generation`. */
export interface DriveWriter {
  readonly threadId: string;
  /** The thread's owner, whose role in the drive the write needs. */
  readonly userId: string;
  readonly generation: number;
  /** Whether the thread has a turn running. `main` only moves during one. */
  readonly live: boolean;
  /** The highest pack sequence the writer has; answers list only newer packs. */
  readonly packsAfter: number;
}

export interface ThreadRefs {
  readonly main: Oid | null;
  readonly thread: Oid | null;
  readonly wip: Oid | null;
  readonly base: Oid | null;
  readonly packs: ReadonlyArray<{
    readonly seq: number;
    readonly name: string;
    readonly size: number;
  }>;
  readonly remote: DriveRemote | null;
  /** Commits in `packs` whose parents are on the remote, not in the drive. */
  readonly shallow: ReadonlyArray<Oid>;
}

export type RefWrite =
  | { readonly _tag: "ok"; readonly refs: ThreadRefs }
  | { readonly _tag: "conflict"; readonly refs: ThreadRefs }
  | { readonly _tag: "refused"; readonly reason: string };

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
    /** Which of `oids` the drive does not have. */
    readonly missing: (oids: ReadonlyArray<Oid>) => Effect.Effect<ReadonlyArray<Oid>, SqlError>;
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
});

/** Applies pending migrations. Ids only ever grow; never renumber one. */
const migrate = Migrator.make({})({ loader: migrations });

const RefRow = Schema.Struct({ name: Schema.String, oid: Schema.String });
const PackRow = Schema.Struct({ seq: Schema.Number, name: Schema.String, size: Schema.Number });
const ThreadRow = Schema.Struct({ base: Schema.NullOr(Schema.String), generation: Schema.Number });
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
const decodeThreadRows = Schema.decodeUnknownSync(Schema.Array(ThreadRow));
const decodeRemoteRows = Schema.decodeUnknownSync(Schema.Array(RemoteRow));
const decodeLocationRows = Schema.decodeUnknownSync(Schema.Array(LocationRow));
const decodeCommitRows = Schema.decodeUnknownSync(Schema.Array(CommitRow));
const decodeShortcutRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ path: Schema.String, target: Schema.String })),
);
const OidRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ oid: Schema.String })));

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

  const ref: DriveStore["Service"]["ref"] = (name) =>
    sql`SELECT name, oid FROM refs WHERE name = ${name}`.pipe(
      Effect.map((rows) => decodeRefRows(rows)[0]?.oid ?? null),
    );

  const threadRow = (threadId: string) =>
    sql`SELECT base, generation FROM threads WHERE thread_id = ${threadId}`.pipe(
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
        yield* sql`SELECT seq, name, size FROM packs WHERE seq > ${packsAfter} ORDER BY seq`,
      );
      const thread = threadId === null ? null : yield* threadRow(threadId);
      const shallow = OidRows(
        yield* sql`SELECT oid FROM shallow WHERE pack_seq > ${packsAfter} ORDER BY pack_seq, oid`,
      ).map((row) => row.oid);
      return {
        main: yield* ref(MAIN_REF),
        thread: threadId === null ? null : yield* ref(threadRef(threadId)),
        wip: threadId === null ? null : yield* ref(wipRef(threadId)),
        base: thread?.base ?? null,
        packs,
        remote: yield* remote,
        shallow,
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
    );

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

  const NO_ACCESS: RefWrite = {
    _tag: "refused",
    reason: "You no longer have access to change this drive.",
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

  const missing: DriveStore["Service"]["missing"] = (oids) =>
    Effect.gen(function* () {
      const unique = [...new Set(oids)];
      const found = new Set<string>();
      for (const chunk of chunks(unique)) {
        const rows = OidRows(yield* sql`SELECT oid FROM objects WHERE oid IN ${sql.in(chunk)}`);
        for (const row of rows) found.add(row.oid);
      }
      return unique.filter((oid) => !found.has(oid));
    });

  const registerPack: DriveStore["Service"]["registerPack"] = (pack) =>
    Effect.gen(function* () {
      const existing = yield* sql`SELECT seq FROM packs WHERE name = ${pack.name}`;
      if (existing.length > 0) return { _tag: "ok" } as const;
      const absent = yield* missing(pack.external);
      if (absent.length > 0) return { _tag: "missing", oids: absent } as const;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO packs (name, size, object_count, thread_id, created_at)
        VALUES (${pack.name}, ${pack.size}, ${pack.objects.length}, ${pack.threadId}, ${now})`;
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

  const ownRefs = (threadId: string) => new Set([threadRef(threadId), wipRef(threadId)]);

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
        if (!(yield* isCommit(update.new))) {
          return {
            _tag: "refused",
            reason: `The drive does not have commit ${update.new}.`,
          } as const;
        }
      }
      for (const update of updates) {
        const current = yield* ref(update.name);
        // Already where the writer wants it: a retry of a write that landed.
        if (current !== update.old && current !== update.new) {
          return {
            _tag: "conflict",
            refs: yield* refs(writer.threadId, writer.packsAfter),
          } as const;
        }
      }
      for (const update of updates) yield* setRef(update.name, update.new, writer.threadId);
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
      yield* setRef(MAIN_REF, request.newMain, writer.threadId);
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
        yield* setRef(MAIN_REF, request.newMain, writer.threadId);
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
        yield* setRef(MAIN_REF, request.newMain, userId);
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

  return DriveStore.of({
    initialize: Effect.asVoid(migrate.pipe(Effect.provideService(SqlClient.SqlClient, sql))),
    open,
    refs,
    ref,
    missing,
    registerPack,
    updateRefs,
    reconcile,
    setRemote,
    remote,
    mirror,
    locate,
    locateAt,
    commits,
    log,
    replaceMain,
    shortcuts,
    addShortcut,
    removeShortcut,
  });
});

/** The store and the members of the drive named `driveId`, on the object's SQLite. */
export const layer = (driveId: string) =>
  Layer.effect(DriveStore, make).pipe(Layer.provideMerge(DriveMembers.layer(driveId)));
