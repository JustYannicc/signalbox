// @effect-diagnostics nodeBuiltinImport:off - synchronizes worktree removal with process registration.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { sameIdentity } from "./processOps.ts";
import { withRegistryLock } from "./lock.ts";
import { normalizedWorktreePath } from "./inspection.ts";
import { resolveGitCommonDir } from "./paths.ts";
import type { ProcessIdentity, ProcessOps, WorktreeClosureLease } from "./types.ts";

interface WorktreeGateRecord {
  readonly version: 1;
  readonly token: string;
  readonly worktreePath: string;
  readonly pid: number;
  readonly identity: ProcessIdentity;
}

type GateRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "record"; readonly record: WorktreeGateRecord };

const gateDirectory = (commonDir: string): string =>
  NodePath.join(commonDir, "signalbox-agent-processes", "closed-worktrees");

const gatePath = (commonDir: string, worktreePath: string): string => {
  const digest = NodeCrypto.createHash("sha256").update(worktreePath).digest("hex");
  return NodePath.join(gateDirectory(commonDir), `${digest}.json`);
};

const isIdentity = (value: unknown): value is ProcessIdentity => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.platform === "string" &&
    typeof record.bootId === "string" &&
    record.bootId.length > 0 &&
    typeof record.startTime === "string" &&
    record.startTime.length > 0
  );
};

const isGateRecord = (value: unknown): value is WorktreeGateRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.token === "string" &&
    typeof record.worktreePath === "string" &&
    NodePath.isAbsolute(record.worktreePath) &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 1 &&
    isIdentity(record.identity)
  );
};

const readGate = (filename: string): GateRead => {
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(filename, "utf8"));
    return isGateRecord(value) ? { kind: "record", record: value } : { kind: "invalid" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "invalid" };
  }
};

const writeGate = (filename: string, record: WorktreeGateRecord): void => {
  const directory = NodePath.dirname(filename);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = NodePath.join(
    directory,
    `.${NodePath.basename(filename)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  const descriptor = NodeFS.openSync(temporary, "wx", 0o600);
  try {
    NodeFS.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    NodeFS.fsyncSync(descriptor);
  } catch (error) {
    NodeFS.closeSync(descriptor);
    NodeFS.rmSync(temporary, { force: true });
    throw error;
  }
  NodeFS.closeSync(descriptor);
  try {
    NodeFS.renameSync(temporary, filename);
  } catch (error) {
    NodeFS.rmSync(temporary, { force: true });
    throw error;
  }
};

const removeStaleGateOrThrow = async (input: {
  readonly filename: string;
  readonly worktreePath: string;
  readonly processOps: ProcessOps;
}): Promise<void> => {
  const gate = readGate(input.filename);
  if (gate.kind === "missing") return;
  if (gate.kind === "invalid" || gate.record.worktreePath !== input.worktreePath) {
    throw new Error(`Cannot verify worktree closure gate at ${input.filename}`);
  }

  const owner = await input.processOps.inspect(gate.record.pid);
  const ownerEnded =
    owner.state === "missing" ||
    (owner.state === "running" && !sameIdentity(owner.identity, gate.record.identity));
  if (ownerEnded) {
    NodeFS.rmSync(input.filename, { force: true });
    return;
  }
  throw new Error(`Worktree is already closed for cleanup: ${input.worktreePath}`);
};

export const assertWorktreeRegistrationOpen = async (input: {
  readonly commonDir: string;
  readonly worktreePath: string;
  readonly processOps: ProcessOps;
}): Promise<void> =>
  removeStaleGateOrThrow({
    filename: gatePath(input.commonDir, input.worktreePath),
    worktreePath: input.worktreePath,
    processOps: input.processOps,
  });

export const closeWorktreeGate = async (input: {
  readonly worktreePath: string;
  readonly processOps: ProcessOps;
  readonly commonDirResolver?: (worktreePath: string) => string;
}): Promise<WorktreeClosureLease> => {
  const worktreePath = normalizedWorktreePath(input.worktreePath);
  const commonDir = (input.commonDirResolver ?? resolveGitCommonDir)(worktreePath);
  const identity = await input.processOps.identify(process.pid);
  if (identity === undefined) {
    throw new Error("Cannot close worktree: cleanup process identity is unavailable");
  }
  const filename = gatePath(commonDir, worktreePath);
  const record: WorktreeGateRecord = {
    version: 1,
    token: NodeCrypto.randomUUID(),
    worktreePath,
    pid: process.pid,
    identity,
  };

  await withRegistryLock({
    commonDir,
    processOps: input.processOps,
    run: async () => {
      await removeStaleGateOrThrow({ filename, worktreePath, processOps: input.processOps });
      writeGate(filename, record);
    },
  });

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    await withRegistryLock({
      commonDir,
      processOps: input.processOps,
      run: () => {
        const gate = readGate(filename);
        if (gate.kind === "record" && gate.record.token === record.token) {
          NodeFS.rmSync(filename, { force: true });
        } else if (gate.kind === "invalid") {
          throw new Error(`Cannot verify worktree closure gate at ${filename}`);
        }
      },
    });
    released = true;
  };

  return { commonDir, release };
};
