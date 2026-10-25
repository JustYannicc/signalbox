// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Lock deadlines run in Node before application Effect setup.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { sameIdentity } from "./processOps.ts";
import type { ProcessIdentity, ProcessOps } from "./types.ts";

interface LockRecord {
  readonly token: string;
  readonly pid: number;
  readonly identity?: ProcessIdentity;
}

const waitForRetry = async (processOps: ProcessOps): Promise<void> => processOps.wait(10);

const isStaleLock = async (lock: LockRecord, processOps: ProcessOps): Promise<boolean> => {
  if (lock.pid === process.pid || lock.identity === undefined) return false;
  const current = await processOps.inspect(lock.pid);
  return (
    current.state === "missing" ||
    (current.state === "running" && !sameIdentity(current.identity, lock.identity))
  );
};

const readLock = (filePath: string): LockRecord | undefined => {
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.token !== "string" || !Number.isSafeInteger(record.pid)) return undefined;
    return record as unknown as LockRecord;
  } catch {
    return undefined;
  }
};

const writeLock = (descriptor: number, record: LockRecord): void => {
  NodeFS.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
  NodeFS.fsyncSync(descriptor);
};

const recoverStaleLock = async (input: {
  readonly lockPath: string;
  readonly expected: LockRecord;
  readonly recoveryRecord: LockRecord;
  readonly processOps: ProcessOps;
  readonly deadline: number;
}): Promise<void> => {
  const recoveryPath = `${input.lockPath}.recovery`;
  let descriptor: number;
  try {
    descriptor = NodeFS.openSync(recoveryPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (Date.now() >= input.deadline) {
      throw new Error(
        `Timed out waiting for stale-lock recovery mutex at ${recoveryPath}; inspect its owner before removing it`,
        { cause: error },
      );
    }
    await waitForRetry(input.processOps);
    return;
  }

  try {
    try {
      writeLock(descriptor, input.recoveryRecord);
    } catch (error) {
      NodeFS.rmSync(recoveryPath, { force: true });
      throw error;
    }

    const stale = await isStaleLock(input.expected, input.processOps);
    const latest = readLock(input.lockPath);
    if (stale && latest?.token === input.expected.token) {
      // Only the recovery-mutex owner deletes the primary, and no await separates
      // the token comparison from unlink, so another recovery cannot remove a successor.
      NodeFS.rmSync(input.lockPath, { force: true });
    }
  } finally {
    NodeFS.closeSync(descriptor);
    if (readLock(recoveryPath)?.token === input.recoveryRecord.token) {
      NodeFS.rmSync(recoveryPath, { force: true });
    }
  }
};

export const withRegistryLock = async <Value>(input: {
  readonly commonDir: string;
  readonly processOps: ProcessOps;
  readonly run: () => Value | Promise<Value>;
}): Promise<Value> => {
  const directory = NodePath.join(input.commonDir, "signalbox-agent-processes");
  const lockPath = NodePath.join(directory, "registry.lock");
  const identity = await input.processOps.identify(process.pid);
  const record: LockRecord = {
    token: NodeCrypto.randomUUID(),
    pid: process.pid,
    ...(identity === undefined ? {} : { identity }),
  };
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const deadline = Date.now() + 5_000;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = NodeFS.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readLock(lockPath);
      if (current !== undefined && (await isStaleLock(current, input.processOps))) {
        await recoverStaleLock({
          lockPath,
          expected: current,
          recoveryRecord: { ...record, token: NodeCrypto.randomUUID() },
          processOps: input.processOps,
          deadline,
        });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for process registry lock at ${lockPath}; its owner is live, unknown, or unverifiable`,
          { cause: error },
        );
      }
      await waitForRetry(input.processOps);
      continue;
    }

    try {
      writeLock(descriptor, record);
    } catch (error) {
      NodeFS.closeSync(descriptor);
      descriptor = undefined;
      NodeFS.rmSync(lockPath, { force: true });
      throw error;
    }
  }

  try {
    return await input.run();
  } finally {
    NodeFS.closeSync(descriptor);
    if (readLock(lockPath)?.token === record.token) NodeFS.rmSync(lockPath, { force: true });
  }
};
