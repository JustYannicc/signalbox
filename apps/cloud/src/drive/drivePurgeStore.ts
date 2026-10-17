import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { Oid } from "./git/gitObjects.ts";

export interface DrivePurgeRef {
  readonly name: string;
  readonly oid: Oid;
}

/** Durable receipt for one thread's irreversible drive purge and later pack GC. */
export interface DrivePurgeReceipt {
  readonly purgeId: string;
  readonly threadId: string | null;
  readonly driveId: string | null;
  readonly purgedAt: number;
  readonly gcAfter: number;
  readonly threadState: {
    readonly base: Oid | null;
    readonly generation: number;
    readonly openedAt: number;
  } | null;
  readonly removedRefs: ReadonlyArray<DrivePurgeRef>;
  /** Private packs queued by this purge, whether pending or already removed. */
  readonly candidatePackNames: ReadonlyArray<string>;
  readonly pendingPackNames: ReadonlyArray<string>;
  readonly removedPackNames: ReadonlyArray<string>;
  /** Packs kept because they are public or owned privately by another thread. */
  readonly retainedPackNames: ReadonlyArray<string>;
}

export type DrivePurgeResult =
  | { readonly _tag: "purged"; readonly receipt: DrivePurgeReceipt }
  | { readonly _tag: "retained"; readonly reason: string };

export interface DrivePurgeInput {
  readonly purgeId: string;
  readonly threadId: string;
  readonly purgedAt: number;
  readonly gcAfter: number;
}

export interface Service {
  readonly purgeThread: (input: DrivePurgeInput) => Effect.Effect<DrivePurgeReceipt, SqlError>;
  readonly purgeDrive: (input: {
    readonly userId: string;
    readonly purgeId: string;
    readonly purgedAt: number;
    readonly gcAfter: number;
  }) => Effect.Effect<DrivePurgeResult, SqlError>;
  readonly drivePurged: Effect.Effect<boolean, SqlError>;
  readonly claimPurgedPacks: (
    purgeId: string,
    now: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<string> | null, SqlError>;
  readonly releasePurgedPacks: (
    purgeId: string,
    names: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  readonly finishPurgedPacks: (
    purgeId: string,
    names: ReadonlyArray<string>,
  ) => Effect.Effect<DrivePurgeReceipt | null, SqlError>;
  readonly purgeReceipt: (purgeId: string) => Effect.Effect<DrivePurgeReceipt | null, SqlError>;
}

/** Part of DriveStore's additive `0007_thread_purge` DO migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_purges (
    purge_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('thread', 'drive')),
    thread_id TEXT,
    drive_id TEXT,
    purged_at INTEGER NOT NULL,
    gc_after INTEGER NOT NULL,
    thread_base TEXT,
    thread_generation INTEGER,
    thread_opened_at INTEGER
  )`;
  yield* sql`CREATE INDEX thread_purges_thread_id ON thread_purges (thread_id)`;
  yield* sql`CREATE TABLE drive_purges (
    purge_id TEXT PRIMARY KEY,
    drive_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    purged_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE thread_purge_refs (
    purge_id TEXT NOT NULL,
    name TEXT NOT NULL,
    oid TEXT NOT NULL,
    PRIMARY KEY (purge_id, name)
  )`;
  yield* sql`CREATE TABLE thread_purge_packs (
    purge_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    pack_name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'public', 'drive')),
    state TEXT NOT NULL,
    claimed_at INTEGER,
    PRIMARY KEY (purge_id, pack_name)
  )`;
  yield* sql`CREATE INDEX thread_purge_packs_state ON thread_purge_packs (purge_id, state)`;
  yield* sql`CREATE INDEX thread_purge_packs_name ON thread_purge_packs (pack_name, state)`;
  yield* sql`CREATE TABLE object_edges (
    oid TEXT NOT NULL,
    dependency_oid TEXT NOT NULL,
    PRIMARY KEY (oid, dependency_oid)
  )`;
  yield* sql`CREATE INDEX object_edges_dependency ON object_edges (dependency_oid)`;
  // Existing commit topology is already indexed separately; copy it into the
  // unified edge table so the same walk can follow commit parents and trees.
  yield* sql`INSERT OR IGNORE INTO object_edges (oid, dependency_oid)
    SELECT oid, tree FROM commits`;
  yield* sql`INSERT OR IGNORE INTO object_edges (oid, dependency_oid)
    SELECT oid, parent FROM commit_parents`;
});

const RefRow = Schema.Struct({ name: Schema.String, oid: Schema.String });
const decodeRefRows = Schema.decodeUnknownSync(Schema.Array(RefRow));
const decodePurgeRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      purge_id: Schema.String,
      target_kind: Schema.Literals(["thread", "drive"]),
      thread_id: Schema.NullOr(Schema.String),
      drive_id: Schema.NullOr(Schema.String),
      purged_at: Schema.Number,
      gc_after: Schema.Number,
      thread_base: Schema.NullOr(Schema.String),
      thread_generation: Schema.NullOr(Schema.Number),
      thread_opened_at: Schema.NullOr(Schema.Number),
    }),
  ),
);
const decodePurgePackRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ pack_name: Schema.String, state: Schema.String, scope: Schema.String }),
  ),
);
const PURGE_PACK_BATCH_MAX = 100;
const PURGE_PACK_CLAIM_MS = 5 * 60 * 1_000;
const SQL_CHUNK = 90;
const chunks = <A>(items: ReadonlyArray<A>) =>
  Array.from({ length: Math.ceil(items.length / SQL_CHUNK) }, (_, i) =>
    items.slice(i * SQL_CHUNK, (i + 1) * SQL_CHUNK),
  );

const refRoots = (threadId: string) => [
  `threads/${threadId}`,
  `wip/${threadId}`,
  `machine/${threadId}`,
  `checkpoint/${threadId}`,
  `checkpoints/${threadId}`,
  `state/${threadId}`,
  `states/${threadId}`,
];

const isThreadRef = (name: string, threadId: string) =>
  refRoots(threadId).some((root) => name === root || name.startsWith(`${root}/`));

export const make = (sql: SqlClient.SqlClient, driveId: string): Service => {
  const drivePurged: Service["drivePurged"] = sql`SELECT purge_id FROM drive_purges LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0),
  );

  const purgeReceipt: Service["purgeReceipt"] = (purgeId) =>
    Effect.gen(function* () {
      const row = decodePurgeRows(
        yield* sql`SELECT purge_id, target_kind, thread_id, drive_id, purged_at, gc_after, thread_base,
            thread_generation, thread_opened_at
          FROM thread_purges WHERE purge_id = ${purgeId}`,
      )[0];
      if (row === undefined) return null;
      const removedRefs = decodeRefRows(
        yield* sql`SELECT name, oid FROM thread_purge_refs WHERE purge_id = ${purgeId}
          ORDER BY name`,
      );
      const packs = decodePurgePackRows(
        yield* sql`SELECT pack_name, state, scope FROM thread_purge_packs WHERE purge_id = ${purgeId}
          ORDER BY pack_name`,
      );
      const threadState =
        row.thread_generation === null || row.thread_opened_at === null
          ? null
          : {
              base: row.thread_base,
              generation: row.thread_generation,
              openedAt: row.thread_opened_at,
            };
      return {
        purgeId: row.purge_id,
        threadId: row.thread_id,
        driveId: row.drive_id,
        purgedAt: row.purged_at,
        gcAfter: row.gc_after,
        threadState,
        removedRefs,
        candidatePackNames: packs
          .filter((pack) => pack.state !== "retained")
          .map((pack) => pack.pack_name),
        pendingPackNames: packs
          .filter((pack) => pack.state === "pending" || pack.state === "deleting")
          .map((pack) => pack.pack_name),
        removedPackNames: packs
          .filter((pack) => pack.state === "removed")
          .map((pack) => pack.pack_name),
        retainedPackNames: packs
          .filter((pack) => pack.state === "retained")
          .map((pack) => pack.pack_name),
      } satisfies DrivePurgeReceipt;
    });

  const purgeThreadIn = (input: DrivePurgeInput) =>
    Effect.gen(function* () {
      const existing = decodePurgeRows(
        yield* sql`SELECT purge_id, target_kind, thread_id, drive_id, purged_at, gc_after, thread_base,
            thread_generation, thread_opened_at
          FROM thread_purges WHERE purge_id = ${input.purgeId}`,
      )[0];
      if (existing !== undefined) {
        if (existing.target_kind !== "thread" || existing.thread_id !== input.threadId) {
          return yield* Effect.die(
            new Error("A drive purge id cannot be reused for another thread."),
          );
        }
        return (yield* purgeReceipt(input.purgeId))!;
      }

      const [thread] = yield* sql<{
        readonly base: string | null;
        readonly generation: number;
        readonly opened_at: number;
      }>`SELECT base, generation, opened_at FROM threads WHERE thread_id = ${input.threadId}`;
      const ownedRefs = decodeRefRows(yield* sql`SELECT name, oid FROM refs`).filter((row) =>
        isThreadRef(row.name, input.threadId),
      );
      yield* sql`INSERT INTO thread_purges
        (purge_id, target_kind, thread_id, drive_id, purged_at, gc_after,
          thread_base, thread_generation, thread_opened_at)
        VALUES (${input.purgeId}, 'thread', ${input.threadId}, NULL, ${input.purgedAt}, ${input.gcAfter},
          ${thread?.base ?? null}, ${thread?.generation ?? null}, ${thread?.opened_at ?? null})`;
      for (const chunk of chunks(ownedRefs)) {
        const names = chunk.map((row) => row.name);
        yield* sql`INSERT INTO thread_purge_refs (purge_id, name, oid)
          SELECT ${input.purgeId}, name, oid FROM refs WHERE name IN ${sql.in(names)}`;
        yield* sql`DELETE FROM refs WHERE name IN ${sql.in(names)}`;
      }
      yield* sql`INSERT INTO thread_purge_packs (purge_id, thread_id, pack_name, state)
        SELECT ${input.purgeId}, ${input.threadId}, name, 'pending'
        FROM packs WHERE private_to = ${input.threadId}`;
      yield* sql`INSERT INTO thread_purge_packs (purge_id, thread_id, pack_name, state)
        SELECT ${input.purgeId}, ${input.threadId}, name, 'retained'
        FROM packs WHERE thread_id = ${input.threadId}
          AND (private_to IS NULL OR private_to <> ${input.threadId})`;
      yield* sql`DELETE FROM threads WHERE thread_id = ${input.threadId}`;
      return (yield* purgeReceipt(input.purgeId))!;
    });

  const purgeThread: Service["purgeThread"] = (input) => sql.withTransaction(purgeThreadIn(input));

  const purgeDrive: Service["purgeDrive"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* sql<{ readonly drive_id: string; readonly user_id: string }>`
        SELECT drive_id, user_id FROM drive_purges WHERE purge_id = ${input.purgeId}`;
      if (existing.length > 0) {
        if (existing[0]!.drive_id !== driveId || existing[0]!.user_id !== input.userId) {
          return yield* Effect.die(
            new Error("A drive purge id cannot be reused for another drive or user."),
          );
        }
        const receipt = yield* purgeReceipt(input.purgeId);
        return { _tag: "purged", receipt: receipt! } as const;
      }
      if (
        (yield* sql`SELECT purge_id FROM thread_purges WHERE purge_id = ${input.purgeId}`).length >
        0
      ) {
        return yield* Effect.die(
          new Error("A thread purge id cannot be reused for a whole drive."),
        );
      }

      if (driveId.split("/", 1)[0] !== "folder") {
        return {
          _tag: "retained",
          reason: "Only a dedicated folder drive can be purged.",
        } as const;
      }
      if ((yield* sql`SELECT id FROM remote WHERE id = 1`).length > 0) {
        return {
          _tag: "retained",
          reason: "A drive backed by a remote repository is retained.",
        } as const;
      }
      const members = yield* sql<{ readonly user_id: string; readonly role: string }>`
        SELECT user_id, role FROM members WHERE role IS NOT NULL ORDER BY user_id`;
      if (
        members.length !== 1 ||
        members[0]!.user_id !== input.userId ||
        members[0]!.role !== "owner"
      ) {
        return {
          _tag: "retained",
          reason: "The drive is shared or its requesting user is not its sole owner.",
        } as const;
      }
      if ((yield* sql`SELECT id FROM drive WHERE id = 1`).length === 0) {
        return { _tag: "retained", reason: "The folder drive has no owner record." } as const;
      }

      const removedRefs = decodeRefRows(yield* sql`SELECT name, oid FROM refs`);
      yield* sql`INSERT INTO drive_purges (purge_id, drive_id, user_id, purged_at)
        VALUES (${input.purgeId}, ${driveId}, ${input.userId}, ${input.purgedAt})`;
      yield* sql`INSERT INTO thread_purges
        (purge_id, target_kind, thread_id, drive_id, purged_at, gc_after,
          thread_base, thread_generation, thread_opened_at)
        VALUES (${input.purgeId}, 'drive', NULL, ${driveId}, ${input.purgedAt}, ${input.gcAfter},
          NULL, NULL, NULL)`;
      for (const chunk of chunks(removedRefs)) {
        const names = chunk.map((row) => row.name);
        yield* sql`INSERT INTO thread_purge_refs (purge_id, name, oid)
          SELECT ${input.purgeId}, name, oid FROM refs WHERE name IN ${sql.in(names)}`;
        yield* sql`DELETE FROM refs WHERE name IN ${sql.in(names)}`;
      }
      yield* sql`INSERT INTO thread_purge_packs (purge_id, thread_id, pack_name, scope, state)
        SELECT ${input.purgeId}, '', name, 'drive', 'pending' FROM packs`;
      yield* sql`DELETE FROM threads`;
      // Keep the removed member row as the ordinary access-revision tombstone.
      yield* sql`UPDATE members SET role = NULL, shared_by = NULL, updated_at = ${input.purgedAt},
        revision = revision + 1 WHERE user_id = ${input.userId} AND role IS NOT NULL`;
      const receipt = yield* purgeReceipt(input.purgeId);
      return { _tag: "purged", receipt: receipt! } as const;
    }).pipe(sql.withTransaction);

  const claimPurgedPacks: Service["claimPurgedPacks"] = (purgeId, now, limit) =>
    Effect.gen(function* () {
      const purge = decodePurgeRows(
        yield* sql`SELECT purge_id, target_kind, thread_id, drive_id, purged_at, gc_after, thread_base,
            thread_generation, thread_opened_at
          FROM thread_purges WHERE purge_id = ${purgeId}`,
      )[0];
      if (purge === undefined) return null;
      if (now < purge.gc_after) return [];
      const targetThreadId = purge.thread_id ?? "";

      yield* sql`UPDATE thread_purge_packs SET state = 'removed', claimed_at = NULL
        WHERE purge_id = ${purgeId} AND state IN ('pending', 'deleting')
          AND NOT EXISTS (SELECT 1 FROM packs p WHERE p.name = pack_name)`;
      yield* sql`UPDATE thread_purge_packs SET state = 'retained', claimed_at = NULL
        WHERE purge_id = ${purgeId} AND state = 'pending' AND scope = 'private'
          AND EXISTS (SELECT 1 FROM packs p WHERE p.name = pack_name
            AND (p.private_to IS NULL OR p.private_to <> ${targetThreadId}))`;
      yield* sql`UPDATE thread_purge_packs SET state = 'retained', claimed_at = NULL
        WHERE purge_id = ${purgeId} AND state = 'pending' AND scope = 'public'
          AND EXISTS (SELECT 1 FROM packs p WHERE p.name = pack_name AND p.private_to IS NOT NULL)`;
      yield* sql`UPDATE thread_purge_packs SET state = 'pending', claimed_at = NULL
        WHERE purge_id = ${purgeId} AND state = 'deleting'
          AND claimed_at <= ${now - PURGE_PACK_CLAIM_MS}`;

      if (purge.target_kind === "thread") {
        // An old non-empty tree without recorded edges makes this proof
        // incomplete, so public-pack collection fails closed for that drive.
        yield* sql`WITH RECURSIVE reachable(oid) AS (
            SELECT oid FROM refs
            UNION SELECT base FROM threads WHERE base IS NOT NULL
            UNION SELECT e.dependency_oid FROM object_edges e JOIN reachable r ON e.oid = r.oid
          )
          INSERT OR IGNORE INTO thread_purge_packs (purge_id, thread_id, pack_name, scope, state)
          SELECT ${purgeId}, ${targetThreadId}, p.name, 'public', 'pending' FROM packs p
          WHERE p.private_to IS NULL
            AND NOT EXISTS (SELECT 1 FROM thread_purge_packs q
              WHERE q.purge_id = ${purgeId} AND q.pack_name = p.name)
            AND NOT EXISTS (SELECT 1 FROM pack_entries e JOIN reachable r ON r.oid = e.oid
              WHERE e.pack_seq = p.seq)
            AND NOT EXISTS (
              SELECT 1 FROM reachable r JOIN objects o ON o.oid = r.oid
              WHERE o.type = 'tree' AND o.size > 0
                AND NOT EXISTS (SELECT 1 FROM object_edges edge WHERE edge.oid = o.oid)
            )`;
      }

      const boundedLimit = Math.max(0, Math.min(PURGE_PACK_BATCH_MAX, Math.floor(limit)));
      if (boundedLimit === 0) return [];
      const claimed = yield* sql<{ readonly pack_name: string }>`SELECT q.pack_name
        FROM thread_purge_packs q JOIN packs p ON p.name = q.pack_name
        WHERE q.purge_id = ${purgeId} AND q.thread_id = ${targetThreadId}
          AND q.state = 'pending' AND (
            q.scope = 'drive' OR
            (q.scope = 'private' AND p.private_to = ${targetThreadId}) OR
            (q.scope = 'public' AND p.private_to IS NULL)
          )
        ORDER BY q.pack_name LIMIT ${boundedLimit}`;
      const names = claimed.map((row) => row.pack_name);
      if (names.length > 0) {
        yield* sql`UPDATE thread_purge_packs SET state = 'deleting', claimed_at = ${now}
          WHERE purge_id = ${purgeId} AND state = 'pending'
            AND pack_name IN ${sql.in(names)}`;
      }
      return names;
    }).pipe(sql.withTransaction);

  const releasePurgedPacks: Service["releasePurgedPacks"] = (purgeId, names) =>
    Effect.gen(function* () {
      for (const chunk of chunks([...new Set(names)])) {
        yield* sql`UPDATE thread_purge_packs SET state = 'pending', claimed_at = NULL
          WHERE purge_id = ${purgeId} AND state = 'deleting'
            AND pack_name IN ${sql.in(chunk)}`;
      }
    }).pipe(sql.withTransaction);

  const finishPurgedPacks: Service["finishPurgedPacks"] = (purgeId, names) =>
    Effect.gen(function* () {
      const receipt = yield* purgeReceipt(purgeId);
      if (receipt === null) return null;
      for (const name of [...new Set(names)]) {
        const [claim] = yield* sql<{
          readonly state: string;
          readonly scope: string;
        }>`SELECT state, scope
          FROM thread_purge_packs WHERE purge_id = ${purgeId} AND pack_name = ${name}`;
        if (claim?.state !== "deleting") continue;
        const [pack] = yield* sql<{
          readonly seq: number;
          readonly private_to: string | null;
        }>`SELECT seq, private_to FROM packs WHERE name = ${name}`;
        if (pack === undefined) {
          yield* sql`UPDATE thread_purge_packs SET state = 'removed', claimed_at = NULL
            WHERE purge_id = ${purgeId} AND pack_name = ${name}`;
          continue;
        }
        const target = decodePurgeRows(
          yield* sql`SELECT purge_id, target_kind, thread_id,
          drive_id, purged_at, gc_after, thread_base, thread_generation, thread_opened_at
          FROM thread_purges WHERE purge_id = ${purgeId}`,
        )[0];
        const remove =
          target?.target_kind === "drive" ||
          (claim.scope === "private" && pack.private_to === receipt.threadId) ||
          (claim.scope === "public" && pack.private_to === null);
        if (!remove) {
          yield* sql`UPDATE thread_purge_packs SET state = 'retained', claimed_at = NULL
            WHERE purge_id = ${purgeId} AND pack_name = ${name}`;
          continue;
        }

        yield* sql`DELETE FROM pack_entries WHERE pack_seq = ${pack.seq}`;
        yield* sql`DELETE FROM shallow WHERE pack_seq = ${pack.seq}`;
        yield* sql`UPDATE objects SET
            pack_seq = (SELECT e.pack_seq FROM pack_entries e JOIN packs p ON p.seq = e.pack_seq
              WHERE e.oid = objects.oid ORDER BY CASE WHEN p.private_to IS NULL THEN 0 ELSE 1 END,
              p.seq LIMIT 1),
            offset = (SELECT e.offset FROM pack_entries e JOIN packs p ON p.seq = e.pack_seq
              WHERE e.oid = objects.oid ORDER BY CASE WHEN p.private_to IS NULL THEN 0 ELSE 1 END,
              p.seq LIMIT 1),
            length = (SELECT e.length FROM pack_entries e JOIN packs p ON p.seq = e.pack_seq
              WHERE e.oid = objects.oid ORDER BY CASE WHEN p.private_to IS NULL THEN 0 ELSE 1 END,
              p.seq LIMIT 1),
            type = (SELECT e.type FROM pack_entries e JOIN packs p ON p.seq = e.pack_seq
              WHERE e.oid = objects.oid ORDER BY CASE WHEN p.private_to IS NULL THEN 0 ELSE 1 END,
              p.seq LIMIT 1),
            size = (SELECT e.size FROM pack_entries e JOIN packs p ON p.seq = e.pack_seq
              WHERE e.oid = objects.oid ORDER BY CASE WHEN p.private_to IS NULL THEN 0 ELSE 1 END,
              p.seq LIMIT 1)
          WHERE pack_seq = ${pack.seq}
            AND EXISTS (SELECT 1 FROM pack_entries e WHERE e.oid = objects.oid)`;
        yield* sql`DELETE FROM objects WHERE pack_seq = ${pack.seq}`;
        yield* sql`DELETE FROM packs WHERE seq = ${pack.seq}`;
        yield* sql`DELETE FROM commit_parents
          WHERE oid IN (SELECT c.oid FROM commits c LEFT JOIN objects o ON o.oid = c.oid
            WHERE o.oid IS NULL)`;
        yield* sql`DELETE FROM commits WHERE oid NOT IN (SELECT oid FROM objects)`;
        yield* sql`DELETE FROM object_edges WHERE oid NOT IN (SELECT oid FROM objects)`;
        yield* sql`UPDATE thread_purge_packs SET state = 'removed', claimed_at = NULL
          WHERE purge_id = ${purgeId} AND pack_name = ${name}`;
      }
      return yield* purgeReceipt(purgeId);
    }).pipe(sql.withTransaction);

  return {
    purgeThread,
    purgeDrive,
    drivePurged,
    claimPurgedPacks,
    releasePurgedPacks,
    finishPurgedPacks,
    purgeReceipt,
  };
};
