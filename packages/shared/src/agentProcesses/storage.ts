// @effect-diagnostics nodeBuiltinImport:off - this module persists Node process records.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import type { AgentProcessRecord, ProcessIdentity } from "./types.ts";
import { commonIndexDirectory, worktreeRegistryDirectory } from "./paths.ts";

const isIdentity = (value: unknown): value is ProcessIdentity => {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.platform === "string" &&
    typeof identity.bootId === "string" &&
    typeof identity.startTime === "string" &&
    identity.bootId.length > 0 &&
    identity.startTime.length > 0
  );
};

const isRecord = (value: unknown, filenameId: string): value is AgentProcessRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    record.id === filenameId &&
    /^[a-f0-9]{64}$/.test(filenameId) &&
    typeof record.worktreePath === "string" &&
    NodePath.isAbsolute(record.worktreePath) &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 1 &&
    isIdentity(record.identity) &&
    (record.ownerIdentity === undefined || isIdentity(record.ownerIdentity)) &&
    (record.ownerPid === undefined ||
      (Number.isSafeInteger(record.ownerPid) && (record.ownerPid as number) > 1)) &&
    (record.sessionId === undefined || typeof record.sessionId === "string") &&
    (record.label === undefined || typeof record.label === "string") &&
    (record.ports === undefined ||
      (Array.isArray(record.ports) &&
        record.ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65_535))) &&
    typeof record.createdAt === "string"
  );
};

const writeJsonAtomically = (filename: string, value: AgentProcessRecord): void => {
  const directory = NodePath.dirname(filename);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = NodePath.join(
    directory,
    `.${NodePath.basename(filename)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  const descriptor = NodeFS.openSync(temporary, "wx", 0o600);
  try {
    NodeFS.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
  try {
    NodeFS.renameSync(temporary, filename);
  } catch (error) {
    NodeFS.rmSync(temporary, { force: true });
    throw error;
  }
};

export const writeRecord = (record: AgentProcessRecord, commonDir: string): void => {
  const indexFile = NodePath.join(commonIndexDirectory(commonDir), `${record.id}.json`);
  const worktreeFile = NodePath.join(
    worktreeRegistryDirectory(record.worktreePath),
    `${record.id}.json`,
  );
  writeJsonAtomically(indexFile, record);
  // Keep the common-dir copy if this mirror fails: it is the recovery point
  // used to find and inspect a process after its worktree directory is gone.
  writeJsonAtomically(worktreeFile, record);
};

export const recordId = (input: {
  readonly worktreePath: string;
  readonly pid: number;
  readonly identity: ProcessIdentity;
}): string =>
  NodeCrypto.createHash("sha256")
    .update(
      [
        input.worktreePath,
        String(input.pid),
        input.identity.platform,
        input.identity.bootId,
        input.identity.startTime,
      ].join("\0"),
    )
    .digest("hex");

const readRecordFile = (filename: string): AgentProcessRecord | undefined => {
  const id = NodePath.basename(filename, ".json");
  try {
    const decoded: unknown = JSON.parse(NodeFS.readFileSync(filename, "utf8"));
    return isRecord(decoded, id) ? decoded : undefined;
  } catch {
    return undefined;
  }
};

export const readRecords = (commonDir: string): Array<AgentProcessRecord> => {
  const directory = commonIndexDirectory(commonDir);
  let filenames: Array<string>;
  try {
    filenames = NodeFS.readdirSync(directory).filter((filename) => filename.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return filenames
    .map((filename) => readRecordFile(NodePath.join(directory, filename)))
    .filter((record): record is AgentProcessRecord => record !== undefined);
};

export const removeRecord = (record: AgentProcessRecord, commonDir: string): void => {
  NodeFS.rmSync(NodePath.join(commonIndexDirectory(commonDir), `${record.id}.json`), {
    force: true,
  });
  NodeFS.rmSync(
    NodePath.join(worktreeRegistryDirectory(record.worktreePath), `${record.id}.json`),
    { force: true },
  );
};
