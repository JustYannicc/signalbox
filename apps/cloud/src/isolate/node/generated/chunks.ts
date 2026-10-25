import { FILE_CHUNK_BYTES, type FacetStorage } from "../../../kernel/FacetSqliteStorage.ts";
import { NodeGeneratedCodeIntegrityError } from "./errors.ts";
import { generatedCodeUtf8ByteLength } from "./graph.ts";

const chunkCharacters = Math.floor(FILE_CHUNK_BYTES / 3);

/** Bounds both rows and bytes before reconstructing an entry, including corrupted SQLite content. */
export function readGeneratedCodeChunks(
  storage: FacetStorage,
  scopeId: string,
  table: "node_generated_code_chunk_v1" | "node_generated_function_index_chunk_v1",
  key: string,
  count: unknown,
  expectedBytes: number,
): string {
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > Math.ceil(expectedBytes / chunkCharacters) + 1
  ) {
    throw new NodeGeneratedCodeIntegrityError(key);
  }
  const rows = storage.sql.exec(
    `SELECT part, CASE WHEN length(CAST(source AS BLOB)) <= ? THEN source ELSE NULL END AS source
     FROM ${table} WHERE scope_id = ? AND code_key = ? ORDER BY part ASC LIMIT ?`,
    Math.min(expectedBytes, FILE_CHUNK_BYTES),
    scopeId,
    key,
    count + 1,
  );
  let source = "";
  let bytes = 0;
  let part = 0;
  for (const row of rows) {
    if (part >= count || row.part !== part || typeof row.source !== "string")
      throw new NodeGeneratedCodeIntegrityError(key);
    bytes += generatedCodeUtf8ByteLength(row.source);
    if (bytes > expectedBytes) throw new NodeGeneratedCodeIntegrityError(key);
    source += row.source;
    part++;
  }
  if (part !== count || bytes !== expectedBytes) throw new NodeGeneratedCodeIntegrityError(key);
  return source;
}

export function splitGeneratedCodeSource(source: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  do {
    let end = Math.min(start + chunkCharacters, source.length);
    const last = source.charCodeAt(end - 1);
    if (end < source.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(source.slice(start, end));
    start = end;
  } while (start < source.length);
  return parts;
}
