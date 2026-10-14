import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { parseDriveId } from "../drive/driveAccess.ts";
import { projectIdForDrive } from "./contextProjects.ts";
import { decodeFolderRows, decodePlacementRows } from "./folderRows.ts";
import type { IndexedDrive } from "./UserDriveIndex.ts";

/**
 * Gives each drive the user is given its own folder, once. The first time
 * takes the drive's placement from before folders, when it had one.
 * Answers whether it made any.
 */
export const foldDrives = Effect.fn("UserFolders.foldDrives")(function* (
  indexed: ReadonlyArray<IndexedDrive>,
) {
  const sql = yield* SqlClient.SqlClient;
  const done = new Set(
    (yield* sql<{ readonly drive_id: string }>`SELECT drive_id FROM folder_drives`).map(
      (row) => row.drive_id,
    ),
  );
  const fresh = indexed.filter((drive) => !done.has(drive.driveId));
  yield* Effect.annotateCurrentSpan("drives.new", fresh.length);
  if (fresh.length === 0) return false;
  const placements = new Map(
    decodePlacementRows(
      yield* sql`SELECT project_id, section_id, position FROM project_placements`,
    ).map((row) => [row.project_id, row]),
  );
  // Placed ones in their old order, then the rest as the index lists them.
  const placed = (drive: IndexedDrive) =>
    placements.get(projectIdForDrive(drive.driveId))?.position ?? Number.MAX_SAFE_INTEGER;
  const ordered = fresh.toSorted((left, right) => placed(left) - placed(right));
  for (const drive of ordered) {
    const ownerId = parseDriveId(drive.driveId)?.contextId;
    const projectId = projectIdForDrive(drive.driveId);
    // Its project's id: a pool placed at the project before folders stays its own.
    const id = FolderId.make(projectId);
    const parents = decodeFolderRows(
      yield* sql`SELECT id, owner_id, parent_id, name, position, drive_id, instructions
          FROM folders WHERE id = ${placements.get(projectId)?.section_id ?? ""}`,
    );
    const parentId = parents[0]?.owner_id === ownerId ? (parents[0]?.id ?? null) : null;
    if (ownerId !== undefined) {
      yield* sql`INSERT INTO folders (id, owner_id, parent_id, name, position, drive_id)
          SELECT ${id}, ${ownerId}, ${parentId}, ${drive.name},
            COALESCE((SELECT MAX(position) + 1 FROM folders
              WHERE owner_id = ${ownerId} AND parent_id IS ${parentId}), 0),
            ${drive.driveId}
          WHERE NOT EXISTS (SELECT 1 FROM folders WHERE id = ${id} OR drive_id = ${drive.driveId})`;
    }
    yield* sql`INSERT INTO folder_drives (drive_id) VALUES (${drive.driveId})
        ON CONFLICT (drive_id) DO NOTHING`;
  }
  return true;
});
