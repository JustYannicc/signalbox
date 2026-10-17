import { DriveRemote } from "@signalbox/runner-protocol/DriveProtocol";
import { canManageDrive } from "@t3tools/contracts/signalboxDrives";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type {
  DriveForkOrigin,
  DriveForkResult,
  DriveSnapshot,
  ObjectLocation,
  PackOrigin,
  PromisedFile,
  StoredCommit,
} from "./DriveStore.ts";
import { MAIN_REF } from "./DriveStore.ts";
import type { Oid } from "./git/gitObjects.ts";
import { parseDriveId } from "./driveAccess.ts";

/** The bounded metadata transfer used to give a new drive an independent main ref. */
export interface DriveForkStoreInput {
  readonly driveId: string;
  readonly sql: SqlClient.SqlClient;
  readonly role: (userId: string) => Effect.Effect<SignalboxDriveRole | null, SqlError>;
  readonly remote: Effect.Effect<DriveRemote | null, SqlError>;
  readonly ref: (name: string) => Effect.Effect<Oid | null, SqlError>;
}

const PackRow = Schema.Struct({
  seq: Schema.Number,
  name: Schema.String,
  size: Schema.Number,
  origin_drive_id: Schema.NullOr(Schema.String),
  origin_name: Schema.NullOr(Schema.String),
});
const decodePackRows = Schema.decodeUnknownSync(Schema.Array(PackRow));
const PackEntryRow = Schema.Struct({
  pack: Schema.String,
  oid: Schema.String,
  offset: Schema.Number,
  length: Schema.Number,
  type: Schema.Literals(["commit", "tree", "blob", "tag"]),
  size: Schema.Number,
});
const decodePackEntryRows = Schema.decodeUnknownSync(Schema.Array(PackEntryRow));
const ShallowRow = Schema.Struct({ pack: Schema.String, oid: Schema.String });
const decodeShallowRows = Schema.decodeUnknownSync(Schema.Array(ShallowRow));
const CommitRow = Schema.Struct({
  oid: Schema.String,
  tree: Schema.String,
  author_name: Schema.String,
  author_email: Schema.String,
  time: Schema.Number,
  message: Schema.String,
  parents: Schema.NullOr(Schema.String),
});
const decodeCommitRows = Schema.decodeUnknownSync(Schema.Array(CommitRow));
const decodePromisedRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ oid: Schema.String, size: Schema.NullOr(Schema.Number) })),
);
const encodePromised = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ oid: Schema.String, size: Schema.NullOr(Schema.Number) })),
  ),
);
const decodeOriginRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ drive_id: Schema.String, main: Schema.NullOr(Schema.String) })),
);
const decodeEmptyRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ count: Schema.Number })),
);

const toCommit = (row: typeof CommitRow.Type): StoredCommit => ({
  oid: row.oid,
  tree: row.tree,
  parents: row.parents === null || row.parents === "" ? [] : row.parents.split(","),
  authorName: row.author_name,
  authorEmail: row.author_email,
  time: row.time,
  message: row.message,
});

const toOrigin = (row: typeof PackRow.Type, fallbackDriveId: string): PackOrigin => ({
  driveId: row.origin_drive_id ?? fallbackDriveId,
  name: row.origin_name ?? row.name,
});

const toLocation = (row: typeof PackEntryRow.Type): ObjectLocation => ({
  oid: row.oid,
  pack: row.pack,
  offset: row.offset,
  length: row.length,
  type: row.type,
  size: row.size,
});

const refuse = (reason: string): DriveForkResult => ({ _tag: "refused", reason });

const hasKeys = (value: unknown, keys: ReadonlyArray<string>) =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value).toSorted().join("\n") === [...keys].toSorted().join("\n");

const isOid = (value: unknown): value is Oid =>
  typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);

/** Refuse extra serialized fields so refs, membership, shortcuts or private packs can't slip in. */
const validateSnapshot = (snapshot: DriveSnapshot, targetId: string): string | null => {
  if (!hasKeys(snapshot, ["sourceDriveId", "main", "remote", "packs", "commits", "promised"])) {
    return "The snapshot contains unsupported drive state.";
  }
  try {
    if (parseDriveId(snapshot.sourceDriveId) === null || snapshot.sourceDriveId === targetId) {
      return "The snapshot has an invalid source drive.";
    }
  } catch {
    return "The snapshot has an invalid source drive.";
  }
  if (snapshot.main !== null && !isOid(snapshot.main))
    return "The snapshot has an invalid main ref.";
  if (
    !Array.isArray(snapshot.packs) ||
    !Array.isArray(snapshot.commits) ||
    !Array.isArray(snapshot.promised)
  ) {
    return "The snapshot is incomplete.";
  }
  if (snapshot.remote !== null) {
    try {
      Schema.decodeUnknownSync(DriveRemote)(snapshot.remote);
    } catch {
      return "The snapshot has invalid remote metadata.";
    }
  }

  const packNames = new Set<string>();
  const shallow = new Set<Oid>();
  const commits = new Map<Oid, StoredCommit>();
  const commitObjects = new Set<Oid>();
  for (const pack of snapshot.packs) {
    if (!hasKeys(pack, ["name", "size", "origin", "entries", "shallow"])) {
      return "The snapshot contains private or unsupported pack metadata.";
    }
    if (
      !isOid(pack.name) ||
      packNames.has(pack.name) ||
      !Number.isSafeInteger(pack.size) ||
      pack.size < 0 ||
      !hasKeys(pack.origin, ["driveId", "name"]) ||
      !isOid(pack.origin.name) ||
      pack.origin.name !== pack.name
    )
      return "The snapshot has invalid pack metadata.";
    try {
      if (parseDriveId(pack.origin.driveId) === null || pack.origin.driveId === targetId) {
        return "The snapshot has an invalid pack origin.";
      }
    } catch {
      return "The snapshot has an invalid pack origin.";
    }
    if (!Array.isArray(pack.entries) || !Array.isArray(pack.shallow)) {
      return "The snapshot has incomplete pack metadata.";
    }
    packNames.add(pack.name);
    for (const entry of pack.entries) {
      if (
        !hasKeys(entry, ["oid", "offset", "length", "type", "size"]) ||
        !isOid(entry.oid) ||
        !Number.isSafeInteger(entry.offset) ||
        entry.offset < 0 ||
        !Number.isSafeInteger(entry.length) ||
        entry.length <= 0 ||
        entry.offset + entry.length > pack.size ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        !["commit", "tree", "blob", "tag"].includes(entry.type)
      )
        return "The snapshot has invalid pack metadata.";
      if (entry.type === "commit") commitObjects.add(entry.oid);
    }
    for (const oid of pack.shallow) {
      if (!isOid(oid)) return "The snapshot has invalid shallow history.";
      shallow.add(oid);
    }
  }
  for (const commit of snapshot.commits) {
    if (
      !hasKeys(commit, [
        "oid",
        "tree",
        "parents",
        "authorName",
        "authorEmail",
        "time",
        "message",
      ]) ||
      !isOid(commit.oid) ||
      !isOid(commit.tree) ||
      !Array.isArray(commit.parents) ||
      !commit.parents.every(isOid) ||
      typeof commit.authorName !== "string" ||
      typeof commit.authorEmail !== "string" ||
      !Number.isFinite(commit.time) ||
      typeof commit.message !== "string" ||
      commits.has(commit.oid)
    )
      return "The snapshot has invalid commit metadata.";
    commits.set(commit.oid, commit);
  }
  if (
    snapshot.main !== null &&
    (!commits.has(snapshot.main) || !commitObjects.has(snapshot.main))
  ) {
    return "The snapshot does not include its main commit.";
  }
  for (const oid of shallow) {
    if (!commits.has(oid)) return "The snapshot's shallow history is inconsistent.";
  }
  const reachable = new Set<Oid>();
  const pending = snapshot.main === null ? [] : [snapshot.main];
  while (pending.length > 0) {
    const oid = pending.pop()!;
    if (reachable.has(oid)) continue;
    const commit = commits.get(oid);
    if (commit === undefined) return "The snapshot has a missing parent commit.";
    reachable.add(oid);
    for (const parent of commit.parents) {
      if (commits.has(parent)) pending.push(parent);
      else if (!shallow.has(oid)) return "The snapshot has incomplete commit history.";
    }
  }
  if (reachable.size !== commits.size) return "The snapshot includes history outside its main ref.";
  if (
    snapshot.promised.some(
      (file) =>
        !hasKeys(file, ["oid", "size"]) ||
        !isOid(file.oid) ||
        (file.size !== null && (!Number.isSafeInteger(file.size) || file.size < 0)),
    )
  )
    return "The snapshot has invalid promised-file metadata.";
  return null;
};

export const makeDriveForkStore = (input: DriveForkStoreInput) => {
  const { driveId, sql, role, remote, ref } = input;

  const forkSnapshot = (
    userId: string,
  ): Effect.Effect<
    DriveSnapshot | { readonly _tag: "refused"; readonly reason: string },
    SqlError
  > =>
    Effect.gen(function* () {
      if ((yield* role(userId)) === null) {
        return { _tag: "refused", reason: "You don't have access to this drive." } as const;
      }
      const main = yield* ref(MAIN_REF);
      const remoteSource = yield* remote;
      if (main === null) {
        return {
          sourceDriveId: driveId,
          main: null,
          remote:
            remoteSource === null ? null : ({ ...remoteSource, mode: "source" } as DriveRemote),
          packs: [],
          commits: [],
          promised: [],
        } satisfies DriveSnapshot;
      }

      // The public packs form the tree/blob closure for this fixed main without reading bytes.
      // Private machine packs are excluded before any entries or refs are copied.
      const packs = decodePackRows(
        yield* sql`SELECT p.seq, p.name, p.size, po.drive_id AS origin_drive_id,
            po.origin_name AS origin_name
          FROM packs p
          LEFT JOIN pack_origins po ON po.name = p.name
          WHERE p.private_to IS NULL
          ORDER BY p.seq`,
      );
      if (packs.length === 0) {
        return { _tag: "refused", reason: "The drive's main history is unavailable." } as const;
      }
      const packSeqs = packs.map((pack) => pack.seq);
      const entries: Array<typeof PackEntryRow.Type> = [];
      const shallow: Array<typeof ShallowRow.Type> = [];
      for (const seq of packSeqs) {
        entries.push(
          ...decodePackEntryRows(
            yield* sql`SELECT p.name AS pack, e.oid, e.offset, e.length, e.type, e.size
              FROM pack_entries e JOIN packs p ON p.seq = e.pack_seq
              WHERE e.pack_seq = ${seq} ORDER BY e.offset`,
          ),
        );
        shallow.push(
          ...decodeShallowRows(
            yield* sql`SELECT p.name AS pack, s.oid FROM shallow s
              JOIN packs p ON p.seq = s.pack_seq WHERE s.pack_seq = ${seq} ORDER BY s.oid`,
          ),
        );
      }
      const reachableCommits = decodeCommitRows(
        yield* sql`WITH RECURSIVE reach(oid) AS (
            SELECT ${main}
            UNION
            SELECT cp.parent FROM commit_parents cp JOIN reach r ON cp.oid = r.oid
          )
          SELECT c.oid, c.tree, c.author_name, c.author_email, c.time, c.message,
            (SELECT group_concat(parent, ',') FROM
              (SELECT parent FROM commit_parents WHERE oid = c.oid ORDER BY position)) AS parents
          FROM commits c JOIN reach r ON r.oid = c.oid
          WHERE EXISTS (
            SELECT 1 FROM pack_entries e JOIN packs p ON p.seq = e.pack_seq
            WHERE e.oid = c.oid AND e.type = 'commit' AND p.private_to IS NULL
          )
          ORDER BY c.time, c.oid`,
      ).map(toCommit);
      const promised: ReadonlyArray<PromisedFile> = decodePromisedRows(
        yield* sql`SELECT oid, size FROM promised ORDER BY oid`,
      );
      const packed = new Map(packs.map((pack) => [pack.name, pack]));
      const entriesByPack = new Map<string, Array<typeof PackEntryRow.Type>>();
      for (const entry of entries) {
        const group = entriesByPack.get(entry.pack) ?? [];
        group.push(entry);
        entriesByPack.set(entry.pack, group);
      }
      const shallowByPack = new Map<string, Array<Oid>>();
      for (const item of shallow) {
        const group = shallowByPack.get(item.pack) ?? [];
        group.push(item.oid);
        shallowByPack.set(item.pack, group);
      }
      const snapshotPacks = [...packed.values()].map((pack) => ({
        name: pack.name,
        size: pack.size,
        origin: toOrigin(pack, driveId),
        entries: (entriesByPack.get(pack.name) ?? [])
          .map(toLocation)
          .map(({ pack: _pack, ...entry }) => entry),
        shallow: (shallowByPack.get(pack.name) ?? []).filter((oid) =>
          reachableCommits.some((commit) => commit.oid === oid),
        ),
      }));
      const remoteValue = remoteSource === null ? null : { ...remoteSource, mode: "source" };
      return {
        sourceDriveId: driveId,
        main,
        remote: remoteValue,
        packs: snapshotPacks,
        commits: reachableCommits,
        promised,
      } satisfies DriveSnapshot;
    }).pipe(sql.withTransaction);

  const startFrom = (
    userId: string,
    snapshot: DriveSnapshot,
  ): Effect.Effect<DriveForkResult, SqlError> =>
    Effect.gen(function* () {
      if (!canManageDrive(yield* role(userId)))
        return refuse("Only the drive's manager can start it.");
      const invalid = validateSnapshot(snapshot, driveId);
      if (invalid !== null) return refuse(invalid);
      if (snapshot.sourceDriveId === driveId) return refuse("A drive cannot start from itself.");
      const existing = decodeOriginRows(
        yield* sql`SELECT drive_id, main FROM fork_origin WHERE id = 1`,
      )[0];
      if (existing !== undefined) {
        return existing.drive_id === snapshot.sourceDriveId && existing.main === snapshot.main
          ? ({ _tag: "ok" } as const)
          : refuse("This drive was already started from another snapshot.");
      }
      const counts = decodeEmptyRows(
        yield* sql`SELECT
            (SELECT count(*) FROM refs) + (SELECT count(*) FROM packs) +
            (SELECT count(*) FROM commits) + (SELECT count(*) FROM shortcuts) +
            (SELECT count(*) FROM promised) + (SELECT count(*) FROM threads) +
            (SELECT count(*) FROM remote) AS count`,
      );
      if ((counts[0]?.count ?? 0) > 0) return refuse("This drive already has files or history.");

      const now = yield* Clock.currentTimeMillis;
      for (const pack of snapshot.packs) {
        yield* sql`INSERT INTO packs (name, size, object_count, thread_id, created_at, private_to)
          VALUES (${pack.name}, ${pack.size}, ${pack.entries.length}, ${`fork:${snapshot.sourceDriveId}`}, ${now}, NULL)`;
        const [row] = yield* sql<{
          readonly seq: number;
        }>`SELECT seq FROM packs WHERE name = ${pack.name}`;
        const seq = row!.seq;
        yield* sql`INSERT INTO pack_origins (name, drive_id, origin_name)
          VALUES (${pack.name}, ${pack.origin.driveId}, ${pack.origin.name})`;
        for (const entry of pack.entries) {
          yield* sql`INSERT OR IGNORE INTO objects (oid, pack_seq, offset, length, type, size)
            VALUES (${entry.oid}, ${seq}, ${entry.offset}, ${entry.length}, ${entry.type}, ${entry.size})`;
          yield* sql`INSERT INTO pack_entries (pack_seq, offset, oid, length, type, size)
            VALUES (${seq}, ${entry.offset}, ${entry.oid}, ${entry.length}, ${entry.type}, ${entry.size})`;
        }
        for (const oid of pack.shallow) {
          yield* sql`INSERT OR IGNORE INTO shallow (oid, pack_seq) VALUES (${oid}, ${seq})`;
        }
      }
      for (const commit of snapshot.commits) {
        yield* sql`INSERT INTO commits (oid, tree, author_name, author_email, time, message)
          VALUES (${commit.oid}, ${commit.tree}, ${commit.authorName}, ${commit.authorEmail},
            ${commit.time}, ${commit.message})`;
        for (const [position, parent] of commit.parents.entries()) {
          yield* sql`INSERT INTO commit_parents (oid, position, parent)
            VALUES (${commit.oid}, ${position}, ${parent})`;
        }
      }
      if (snapshot.promised.length > 0) {
        yield* sql`INSERT INTO promised (oid, size)
          SELECT value ->> 'oid', value ->> 'size' FROM json_each(${encodePromised(snapshot.promised)})`;
      }
      if (snapshot.remote !== null) {
        yield* sql`INSERT INTO remote (id, provider, repository, default_branch, mode)
          VALUES (1, ${snapshot.remote.provider}, ${snapshot.remote.repository},
            ${snapshot.remote.defaultBranch}, ${snapshot.remote.mode ?? "source"})`;
      }
      if (snapshot.main !== null) {
        yield* sql`INSERT INTO refs (name, oid, updated_by, updated_at)
          VALUES (${MAIN_REF}, ${snapshot.main}, ${userId}, ${now})`;
      }
      yield* sql`INSERT INTO fork_origin (id, drive_id, main)
        VALUES (1, ${snapshot.sourceDriveId}, ${snapshot.main})`;
      return { _tag: "ok" } as const;
    }).pipe(sql.withTransaction);

  const forkOrigin = (userId: string): Effect.Effect<DriveForkOrigin | null, SqlError> =>
    Effect.gen(function* () {
      if (!canManageDrive(yield* role(userId))) return null;
      const row = decodeOriginRows(
        yield* sql`SELECT drive_id, main FROM fork_origin WHERE id = 1`,
      )[0];
      return row === undefined ? null : { driveId: row.drive_id, main: row.main };
    });

  const packOrigin = (name: string): Effect.Effect<PackOrigin | null, SqlError> =>
    sql`SELECT p.name, po.drive_id, po.origin_name FROM packs p
      LEFT JOIN pack_origins po ON po.name = p.name WHERE p.name = ${name}`.pipe(
      Effect.map((rows) => {
        const [row] = Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({
              name: Schema.String,
              drive_id: Schema.NullOr(Schema.String),
              origin_name: Schema.NullOr(Schema.String),
            }),
          ),
        )(rows);
        return row === undefined
          ? null
          : { driveId: row.drive_id ?? driveId, name: row.origin_name ?? row.name };
      }),
    );

  return { forkSnapshot, startFrom, forkOrigin, packOrigin };
};
