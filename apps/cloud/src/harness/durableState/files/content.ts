import { fail } from "./errors.ts";
import { blobTable, checkpointTable, entryTable } from "./sqlite.ts";
import type { HarnessFilesDatabase } from "./types.ts";
import type { HarnessFilesCheckpoint } from "./contracts.ts";

export type PreparedFile = {
  readonly path: string;
  readonly mode: number;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
};

export type PreparedCheckpoint = {
  readonly checkpointId: string;
  readonly parentCheckpointId: string | null;
  readonly manifestSha256: string;
  readonly fileCount: number;
  readonly byteCount: number;
  readonly files: readonly PreparedFile[];
};

const first = (rows: Iterable<Record<string, unknown>>) => rows[Symbol.iterator]().next().value;

function bufferFrom(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bufferFrom(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validatePath(path: string) {
  if (
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return fail("INVALID");
}

export async function prepareCheckpoint(
  checkpoint: HarnessFilesCheckpoint,
): Promise<PreparedCheckpoint> {
  const paths = new Set<string>();
  let byteCount = 0;
  const files: PreparedFile[] = [];
  for (const file of checkpoint.files) {
    validatePath(file.path);
    if (paths.has(file.path)) return fail("INVALID");
    paths.add(file.path);
    byteCount += file.bytes.byteLength;
    if (!Number.isSafeInteger(byteCount)) return fail("LIMIT");
    files.push({
      path: file.path,
      mode: file.mode,
      bytes: file.bytes.slice(),
      byteLength: file.bytes.byteLength,
      sha256: await hash(file.bytes),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = JSON.stringify(
    files.map(({ path, mode, byteLength, sha256 }) => ({ path, mode, byteLength, sha256 })),
  );
  const manifestSha256 = await hash(new TextEncoder().encode(manifest));
  return {
    checkpointId: checkpoint.checkpointId,
    parentCheckpointId: checkpoint.parentCheckpointId,
    manifestSha256,
    fileCount: files.length,
    byteCount,
    files,
  };
}

export function insertCheckpoint(database: HarnessFilesDatabase, checkpoint: PreparedCheckpoint) {
  const previous = first(
    database.sql.exec(
      `SELECT parent_checkpoint_id, manifest_sha256, file_count, byte_count FROM ${checkpointTable} WHERE checkpoint_id = ?`,
      checkpoint.checkpointId,
    ),
  );
  if (previous) {
    if (
      previous.parent_checkpoint_id !== checkpoint.parentCheckpointId ||
      previous.manifest_sha256 !== checkpoint.manifestSha256 ||
      previous.file_count !== checkpoint.fileCount ||
      previous.byte_count !== checkpoint.byteCount
    )
      return fail("CONFLICT");
    return "unchanged" as const;
  }
  database.sql.exec(
    `INSERT INTO ${checkpointTable} (checkpoint_id, parent_checkpoint_id, manifest_sha256, file_count, byte_count) VALUES (?, ?, ?, ?, ?)`,
    checkpoint.checkpointId,
    checkpoint.parentCheckpointId,
    checkpoint.manifestSha256,
    checkpoint.fileCount,
    checkpoint.byteCount,
  );
  for (const file of checkpoint.files) {
    const blob = first(
      database.sql.exec(
        `SELECT byte_length, bytes FROM ${blobTable} WHERE sha256 = ?`,
        file.sha256,
      ),
    );
    if (blob) {
      const bytes = bytesFrom(blob.bytes);
      if (blob.byte_length !== file.byteLength || !bytesEqual(bytes, file.bytes))
        return fail("CORRUPT");
    } else {
      database.sql.exec(
        `INSERT INTO ${blobTable} (sha256, byte_length, bytes) VALUES (?, ?, ?)`,
        file.sha256,
        file.byteLength,
        bufferFrom(file.bytes),
      );
    }
    database.sql.exec(
      `INSERT INTO ${entryTable} (checkpoint_id, path, mode, blob_sha256, byte_length) VALUES (?, ?, ?, ?, ?)`,
      checkpoint.checkpointId,
      file.path,
      file.mode,
      file.sha256,
      file.byteLength,
    );
  }
  return "recorded" as const;
}

function bytesFrom(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  return fail("CORRUPT");
}

const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

export async function readCheckpoint(
  database: HarnessFilesDatabase,
  checkpointId: string,
  action: "read" | "recovered",
) {
  const manifest = first(
    database.sql.exec(
      `SELECT parent_checkpoint_id, manifest_sha256, file_count, byte_count FROM ${checkpointTable} WHERE checkpoint_id = ?`,
      checkpointId,
    ),
  );
  if (!manifest) return fail("MISSING");
  const files: { path: string; mode: number; bytes: Uint8Array }[] = [];
  let byteCount = 0;
  for (const row of database.sql.exec(
    `SELECT path, mode, blob_sha256, byte_length FROM ${entryTable} WHERE checkpoint_id = ? ORDER BY path`,
    checkpointId,
  )) {
    if (typeof row.blob_sha256 !== "string") return fail("CORRUPT");
    const blob = first(
      database.sql.exec(
        `SELECT byte_length, bytes FROM ${blobTable} WHERE sha256 = ?`,
        row.blob_sha256,
      ),
    );
    if (!blob) return fail("CORRUPT");
    const bytes = bytesFrom(blob.bytes);
    if (
      blob.byte_length !== row.byte_length ||
      bytes.byteLength !== row.byte_length ||
      (await hash(bytes)) !== row.blob_sha256
    )
      return fail("CORRUPT");
    byteCount += bytes.byteLength;
    files.push({ path: String(row.path), mode: Number(row.mode), bytes });
  }
  if (files.length !== manifest.file_count || byteCount !== manifest.byte_count)
    return fail("CORRUPT");
  const prepared = await prepareCheckpoint({
    checkpointId,
    parentCheckpointId:
      manifest.parent_checkpoint_id === null ? null : String(manifest.parent_checkpoint_id),
    files,
  });
  if (prepared.manifestSha256 !== manifest.manifest_sha256) return fail("CORRUPT");
  return {
    action,
    checkpointId,
    parentCheckpointId: manifest.parent_checkpoint_id,
    manifestSha256: String(manifest.manifest_sha256),
    files,
  };
}
