import type { FolderId, FolderOrigin } from "@t3tools/contracts/signalboxFolders";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export interface FolderStartReservationInput {
  readonly id: FolderId;
  readonly ownerId: SignalboxContextId;
  readonly driveId: string;
  readonly source: Omit<FolderOrigin, "head">;
  readonly name?: string;
}

export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE folder_start_reservations (
    folder_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    drive_id TEXT NOT NULL UNIQUE,
    source_catalog_home TEXT NOT NULL,
    source_folder_id TEXT NOT NULL,
    source_drive_id TEXT NOT NULL,
    source_name TEXT NOT NULL,
    name TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
  )`;
});

const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      owner_id: Schema.String,
      drive_id: Schema.String,
      source_catalog_home: Schema.String,
      source_folder_id: Schema.String,
      source_drive_id: Schema.String,
      source_name: Schema.String,
      name: Schema.String,
    }),
  ),
);

const copyName = (source: string, used: ReadonlySet<string>) => {
  for (let copy = 1; ; copy++) {
    const suffix = copy === 1 ? " (copy)" : ` (copy ${copy})`;
    const name = `${source.slice(0, 128 - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(name)) return name;
  }
};

/** Bind the full source identity before any drive RPC can leave partial work behind. */
export const reserve = (input: FolderStartReservationInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [existing] = decodeRows(
          yield* sql`SELECT owner_id, drive_id, source_catalog_home, source_folder_id,
            source_drive_id, source_name, name FROM folder_start_reservations
            WHERE folder_id = ${input.id}`,
        );
        if (existing !== undefined) {
          if (
            existing.owner_id !== input.ownerId ||
            existing.drive_id !== input.driveId ||
            existing.source_catalog_home !== input.source.legacyCatalogHome ||
            existing.source_folder_id !== input.source.folderId ||
            existing.source_drive_id !== input.source.driveId
          ) {
            return null;
          }
          return { name: existing.name, sourceName: existing.source_name };
        }

        const names = yield* sql<{ readonly name: string }>`SELECT name FROM folders
          WHERE owner_id = ${input.ownerId} AND parent_id IS NULL
          UNION ALL SELECT name FROM folder_start_reservations
          WHERE owner_id = ${input.ownerId} AND completed = 0`;
        const name =
          input.name?.trim() ?? copyName(input.source.name, new Set(names.map((row) => row.name)));
        yield* sql`INSERT INTO folder_start_reservations
          (folder_id, owner_id, drive_id, source_catalog_home, source_folder_id,
            source_drive_id, source_name, name)
          VALUES (${input.id}, ${input.ownerId}, ${input.driveId},
            ${input.source.legacyCatalogHome}, ${input.source.folderId},
            ${input.source.driveId}, ${input.source.name}, ${name})`;
        // Delivery can race setup; it must not fold this drive into another folder.
        yield* sql`INSERT INTO folder_drives (drive_id) VALUES (${input.driveId})
          ON CONFLICT (drive_id) DO NOTHING`;
        return { name, sourceName: input.source.name };
      }),
    );
  });

/** Keep identity after deletion, while allowing later starts to reuse the deleted name. */
export const complete = (id: FolderId) =>
  SqlClient.SqlClient.use((sql) =>
    sql`UPDATE folder_start_reservations SET completed = 1 WHERE folder_id = ${id}`.pipe(
      Effect.asVoid,
    ),
  );
