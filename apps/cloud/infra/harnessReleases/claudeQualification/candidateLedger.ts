import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import type { HarnessReleaseArtifact } from "../../../src/harnessReleases/HarnessReleaseLedger.ts";
import type { CandidateArtifactRows } from "./candidateVariants.ts";
import type { ClaudeQualificationVariant } from "./contracts.ts";

type Scope = "global" | "project";
type Row = { readonly record_json: unknown };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("CLAUDE_QUALIFICATION_LEDGER_RECORD_INVALID");
  return encoded;
};

/** Reads both pair rows from the standalone candidate ledger without opening a write path. */
export async function readCandidateLedgerArtifactRows(input: {
  readonly path: string;
  readonly scope: Scope;
  readonly expected: Readonly<Record<ClaudeQualificationVariant, HarnessReleaseArtifact>>;
}): Promise<CandidateArtifactRows> {
  const stat = await NodeFSP.lstat(input.path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error("CLAUDE_QUALIFICATION_LEDGER_FILE_INVALID");
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (await exists(`${input.path}${suffix}`))
      throw new Error("CLAUDE_QUALIFICATION_LEDGER_NOT_STANDALONE");

  const database = new NodeSqlite.DatabaseSync(input.path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    const rows = {} as Record<ClaudeQualificationVariant, HarnessReleaseArtifact>;
    for (const variant of ["baseline", "hooks"] as const) {
      const expected = input.expected[variant];
      const stored = readArtifactRow(database, input.scope, expected.releaseId);
      if (stored === null || canonical(stored) !== canonical(expected))
        throw new Error(`CLAUDE_QUALIFICATION_LEDGER_${variant.toUpperCase()}_MISMATCH`);
      rows[variant] = stored;
    }
    return rows;
  } finally {
    database.close();
  }
}

function readArtifactRow(
  database: NodeSqlite.DatabaseSync,
  scope: Scope,
  releaseId: string,
): HarnessReleaseArtifact | null {
  const statement =
    scope === "global"
      ? database.prepare(
          "SELECT record_json FROM harness_release_artifacts WHERE provider = ? AND release_id = ?",
        )
      : database.prepare(
          `SELECT record_json FROM harness_project_release_records
            WHERE kind = 'artifact' AND provider = ? AND release_id = ?`,
        );
  const records = statement.all("claude-code", releaseId) as Row[];
  if (records.length !== 1) {
    if (records.length === 0) return null;
    throw new Error("CLAUDE_QUALIFICATION_LEDGER_ARTIFACT_AMBIGUOUS");
  }
  const value = records[0]?.record_json;
  if (typeof value !== "string") throw new Error("CLAUDE_QUALIFICATION_LEDGER_RECORD_INVALID");
  const decoded: unknown = JSON.parse(value);
  if (!isArtifact(decoded)) throw new Error("CLAUDE_QUALIFICATION_LEDGER_RECORD_INVALID");
  return decoded;
}

async function exists(path: string) {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

function isArtifact(value: unknown): value is HarnessReleaseArtifact {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.get(value, "provider") === "claude-code" &&
    typeof Reflect.get(value, "releaseId") === "string" &&
    typeof Reflect.get(value, "artifactRef") === "string" &&
    typeof Reflect.get(value, "artifactHash") === "string" &&
    typeof Reflect.get(value, "sourceIdentity") === "string" &&
    typeof Reflect.get(value, "fixtureIdentity") === "string" &&
    typeof Reflect.get(value, "createdAt") === "string"
  );
}
