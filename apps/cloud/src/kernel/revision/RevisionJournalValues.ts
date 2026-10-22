import { Schema } from "effect";
import type { ChangedInode } from "../FilePersistencePorts.ts";
import type { Inode } from "../storage.ts";
import type { DirtyInode } from "./RevisionTypes.ts";
import type { FacetStorage } from "../FacetSqliteStorage.ts";
import { createSqliteJsonParts } from "../sqlite/SqliteJsonParts.ts";
import { KernelRevisionWorkspaceError } from "./RevisionErrors.ts";

const ChangedInodeJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      inode: Schema.BigIntFromString,
      paths: Schema.Array(Schema.String),
      removedPaths: Schema.Array(Schema.String),
    }),
  ),
);
const DirtyInodeJson = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ inode: Schema.String, version: Schema.Number })),
);
const decodeChangedInodes = Schema.decodeUnknownSync(ChangedInodeJson);
const encodeChangedInodes = Schema.encodeSync(ChangedInodeJson);
const decodeDirtyInodes = Schema.decodeUnknownSync(DirtyInodeJson);
const encodeDirtyInodes = Schema.encodeSync(DirtyInodeJson);

const stateKey = JSON.stringify(["state"]);
const fields = ["manifest", "changed", "dirty"] as const;
const attemptKey = (id: string, field: (typeof fields)[number]) =>
  JSON.stringify(["attempt", id, field]);
const parts = (database: FacetStorage) =>
  createSqliteJsonParts(database, "kernel_fs_workspace_manifest");

export function installJournalValues(database: FacetStorage): void {
  parts(database).install();
}

function read(database: FacetStorage, key: string, value: unknown): string {
  try {
    return parts(database).read(key, value);
  } catch {
    throw new KernelRevisionWorkspaceError("EIO", "The facet workspace journal is invalid");
  }
}

export function readStateManifest(database: FacetStorage, value: unknown): string {
  return read(database, stateKey, value);
}

/** The state row and its replaced parts share the caller's transaction. */
export function writeStateManifest(database: FacetStorage, json: string): string {
  const store = parts(database);
  store.remove(stateKey);
  return store.write(stateKey, json);
}

export function readAttemptValues(
  database: FacetStorage,
  id: string,
  row: Record<string, unknown>,
) {
  try {
    const changed = decodeChangedInodes(
      read(database, attemptKey(id, "changed"), row.changed_json),
    );
    const dirty = decodeDirtyInodes(read(database, attemptKey(id, "dirty"), row.dirty_json));
    if (
      dirty.some(
        (entry) =>
          !/^[1-9][0-9]*$/.test(entry.inode) ||
          !Number.isSafeInteger(entry.version) ||
          entry.version < 0,
      )
    ) {
      throw new Error("Invalid dirty inode");
    }
    return {
      manifest: read(database, attemptKey(id, "manifest"), row.manifest_json),
      changed: changed.map((entry) => ({ ...entry, inode: entry.inode as Inode })),
      dirty,
    };
  } catch {
    throw new KernelRevisionWorkspaceError("EIO", "The facet workspace journal is invalid");
  }
}

export function writeAttemptValues(
  database: FacetStorage,
  id: string,
  json: {
    readonly manifest: string;
    readonly changed: readonly ChangedInode[];
    readonly dirty: readonly DirtyInode[];
  },
) {
  const store = parts(database);
  return {
    manifest: store.write(attemptKey(id, "manifest"), json.manifest),
    changed: store.write(attemptKey(id, "changed"), encodeChangedInodes(json.changed)),
    dirty: store.write(attemptKey(id, "dirty"), encodeDirtyInodes(json.dirty)),
  };
}

export function deleteAttemptValues(database: FacetStorage, id: string): void {
  const store = parts(database);
  for (const field of fields) store.remove(attemptKey(id, field));
}
