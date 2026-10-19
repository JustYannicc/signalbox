// @effect-diagnostics nodeBuiltinImport:off - owns private proof files and detects replacement.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  COMPUTER_BOXD_PROOF_STAGE,
  ProofLauncherFailure,
  type StagePhase,
  type ProofStageFile,
  type ProofReceipt,
} from "./ProofProtocol.ts";
const COMMIT = /^[a-f0-9]{40,64}$/;
const PHASES = new Set([
  "created",
  "building-runner",
  "preparing-seed",
  "deploying",
  "deployed",
  "seeding",
  "running",
  "recovering",
  "cleanup-confirmed",
  "cleanup-unconfirmed",
  "destroying",
  "destroyed",
  "failed-before-deploy",
  "failed-after-deploy",
]);

interface Identity {
  readonly dev: number;
  readonly ino: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function safeFile(stat: NodeFS.Stats, label: string) {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== 0o600 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new ProofLauncherFailure(`${label} must be an owned regular file with mode 0600.`);
  }
}

async function updateJson(path: string, value: unknown, prior: Identity): Promise<Identity> {
  const target = NodePath.resolve(path);
  const temp = `${target}.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  const contents = `${JSON.stringify(value)}\n`;
  let handle: NodeFSP.FileHandle | undefined;
  try {
    const current = await NodeFSP.lstat(target);
    if (current.isSymbolicLink())
      throw new ProofLauncherFailure("Proof file must not be a symlink.");
    safeFile(current, "Proof file");
    if (current.dev !== prior.dev || current.ino !== prior.ino) {
      throw new ProofLauncherFailure("Proof file was replaced; leaving it untouched.");
    }

    handle = await NodeFSP.open(
      temp,
      NodeFS.constants.O_CREAT |
        NodeFS.constants.O_EXCL |
        NodeFS.constants.O_WRONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    const beforeRename = await NodeFSP.lstat(target);
    if (
      beforeRename.isSymbolicLink() ||
      beforeRename.dev !== prior.dev ||
      beforeRename.ino !== prior.ino
    ) {
      throw new ProofLauncherFailure("Proof file was replaced; leaving it untouched.");
    }
    await NodeFSP.rename(temp, target);
    const written = await NodeFSP.lstat(target);
    if (written.isSymbolicLink())
      throw new ProofLauncherFailure("Proof file must not be a symlink.");
    safeFile(written, "Proof file");
    return { dev: written.dev, ino: written.ino };
  } catch (error) {
    if (error instanceof ProofLauncherFailure) throw error;
    throw new ProofLauncherFailure("Could not write the private proof file.");
  } finally {
    await handle?.close().catch(() => undefined);
    await NodeFSP.unlink(temp).catch(() => undefined);
  }
}

async function createJson(path: string, value: unknown): Promise<Identity> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(
      NodePath.resolve(path),
      NodeFS.constants.O_CREAT |
        NodeFS.constants.O_EXCL |
        NodeFS.constants.O_WRONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    const stat = await handle.stat();
    safeFile(stat, "Proof file");
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error instanceof ProofLauncherFailure) throw error;
    throw new ProofLauncherFailure("Could not create the private proof file.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseStage(value: unknown): ProofStageFile {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "phase,sourceCommit,stage,version" ||
    value.version !== 1 ||
    typeof value.stage !== "string" ||
    !COMPUTER_BOXD_PROOF_STAGE.test(value.stage) ||
    typeof value.sourceCommit !== "string" ||
    !COMMIT.test(value.sourceCommit) ||
    typeof value.phase !== "string" ||
    !PHASES.has(value.phase)
  ) {
    throw new ProofLauncherFailure("The recovery stage file is invalid.");
  }
  return {
    version: 1,
    stage: value.stage,
    sourceCommit: value.sourceCommit,
    phase: value.phase as StagePhase,
  };
}

function stageHandle(path: string, initial: ProofStageFile, identity: Identity) {
  let record = initial;
  return {
    get record() {
      return record;
    },
    async update(phase: StagePhase) {
      const next = { ...record, phase };
      identity = await updateJson(path, next, identity);
      record = next;
    },
  };
}

export async function createStageFile(path: string, record: ProofStageFile) {
  const initial = parseStage(record);
  const identity = await createJson(path, initial);
  return stageHandle(path, initial, identity);
}

export async function readStageFile(path: string) {
  const absolute = NodePath.resolve(path);
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      absolute,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new ProofLauncherFailure("Could not open the recovery stage file.");
  }
  let record: ProofStageFile;
  let identity: Identity;
  try {
    const stat = await handle.stat();
    safeFile(stat, "Recovery stage file");
    if (stat.size > 4096) throw new ProofLauncherFailure("The recovery stage file is too large.");
    identity = { dev: stat.dev, ino: stat.ino };
    record = parseStage(JSON.parse(await handle.readFile("utf8")));
    const current = await NodeFSP.lstat(absolute);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new ProofLauncherFailure("Recovery stage file was replaced; leaving it untouched.");
    }
  } catch (error) {
    if (error instanceof ProofLauncherFailure) throw error;
    throw new ProofLauncherFailure("The recovery stage file is invalid.");
  } finally {
    await handle.close();
  }
  return stageHandle(absolute, record, identity);
}

export async function createReceiptFile(path: string, receipt: ProofReceipt) {
  let identity = await createJson(path, receipt);
  return async (next: ProofReceipt) => {
    identity = await updateJson(path, next, identity);
  };
}
