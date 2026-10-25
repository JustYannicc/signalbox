// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Process runners use this Node API before application Effect setup.
import * as NodeFS from "node:fs";

import { canonicalDirectory, resolveGitCommonDir } from "./paths.ts";
import { describeInspection, normalizedWorktreePath } from "./inspection.ts";
import { createNodeProcessOps, sameIdentity } from "./processOps.ts";
import { withRegistryLock } from "./lock.ts";
import { readRecords, recordId, removeRecord, writeRecord } from "./storage.ts";
import { stopRecords } from "./stop.ts";
import { assertWorktreeRegistrationOpen, closeWorktreeGate } from "./worktreeGate.ts";
import type {
  AgentProcessRecord,
  AgentProcessRegistry,
  AgentProcessRegistryOptions,
  AgentProcessStatus,
  ProcessMetrics,
  RegisterProcessInput,
  RegistryReadOptions,
  ReapOptions,
  ReapResult,
  StopOptions,
  StopResult,
  WorktreeClosureLease,
} from "./types.ts";

export type {
  AgentProcessRecord,
  AgentProcessRegistry,
  AgentProcessStatus,
  ProcessIdentity,
  ProcessInspection,
  ProcessMetrics,
  ProcessOps,
  ProcessStatusState,
  ProcessSurvivor,
  RegisterProcessInput,
  RegistryReadOptions,
  ReapOptions,
  ReapResult,
  StopOptions,
  StopResult,
  WorktreeClosureLease,
} from "./types.ts";

const STATUS_INSPECTION_BATCH_SIZE = 8;

const mapInBatches = async <Input, Output>(
  values: ReadonlyArray<Input>,
  run: (value: Input) => Promise<Output>,
): Promise<Array<Output>> => {
  const results: Array<Output> = [];
  for (let offset = 0; offset < values.length; offset += STATUS_INSPECTION_BATCH_SIZE) {
    results.push(
      ...(await Promise.all(values.slice(offset, offset + STATUS_INSPECTION_BATCH_SIZE).map(run))),
    );
  }
  return results;
};

export const createAgentProcessRegistry = (
  options: AgentProcessRegistryOptions = {},
): AgentProcessRegistry => {
  const processOps = options.processOps ?? createNodeProcessOps();
  const resolveCommonDir = options.commonDirResolver ?? resolveGitCommonDir;

  const read = (readOptions: RegistryReadOptions = {}) => {
    const worktreePath =
      readOptions.worktreePath === undefined
        ? undefined
        : normalizedWorktreePath(readOptions.worktreePath);
    const commonDir =
      readOptions.commonDir === undefined
        ? resolveCommonDir(worktreePath ?? process.cwd())
        : canonicalDirectory(readOptions.commonDir);
    const records = readRecords(commonDir);
    return {
      commonDir,
      records:
        worktreePath === undefined
          ? records
          : records.filter((record) => record.worktreePath === worktreePath),
    };
  };

  const registerProcess = async (input: RegisterProcessInput): Promise<() => Promise<void>> => {
    validateRegistration(input);
    const worktreePath = canonicalDirectory(input.worktreePath);
    const commonDir = resolveCommonDir(worktreePath);
    const inspection = await processOps.inspect(input.pid);
    if (inspection.state !== "running") {
      const reason = inspection.state === "unknown" ? inspection.reason : "process exited";
      throw new Error(`Cannot register pid ${input.pid}: ${reason}`);
    }
    const prospective = {
      version: 1 as const,
      id: "",
      worktreePath,
      pid: input.pid,
      identity: inspection.identity,
      createdAt: "",
    } satisfies Pick<
      AgentProcessRecord,
      "version" | "id" | "worktreePath" | "pid" | "identity" | "createdAt"
    >;
    const currentState = describeInspection(prospective, inspection);
    if (currentState.state !== "running") {
      throw new Error(
        `Cannot register pid ${input.pid}: ${currentState.reason ?? currentState.state}`,
      );
    }

    const id = recordId({ worktreePath, pid: input.pid, identity: inspection.identity });
    await withRegistryLock({
      commonDir,
      processOps,
      run: async () => {
        let currentWorktreePath: string;
        let currentCommonDir: string;
        try {
          currentWorktreePath = canonicalDirectory(worktreePath);
          currentCommonDir = resolveCommonDir(currentWorktreePath);
        } catch {
          throw new Error(`Cannot register pid ${input.pid}: worktree is no longer available`);
        }
        if (currentWorktreePath !== worktreePath || currentCommonDir !== commonDir) {
          throw new Error(`Cannot register pid ${input.pid}: worktree changed during registration`);
        }
        await assertWorktreeRegistrationOpen({ commonDir, worktreePath, processOps });
        const existing = readRecords(commonDir).find((record) => record.id === id);
        assertSameOwnership(input, existing);
        const ownerPid = input.ownerPid ?? existing?.ownerPid;
        const ownerIdentity =
          existing?.ownerIdentity ??
          (ownerPid === undefined ? undefined : await processOps.identify(ownerPid));
        const sessionId = input.sessionId ?? existing?.sessionId;
        const label = input.label ?? existing?.label;
        const record: AgentProcessRecord = {
          version: 1,
          id,
          worktreePath,
          pid: input.pid,
          identity: inspection.identity,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(label === undefined ? {} : { label }),
          ...(ownerPid === undefined ? {} : { ownerPid }),
          ...(input.ports === undefined && existing?.ports === undefined
            ? {}
            : { ports: [...new Set([...(existing?.ports ?? []), ...(input.ports ?? [])])] }),
          ...(ownerIdentity === undefined ? {} : { ownerIdentity }),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        writeRecord(record, commonDir);
      },
    });

    let unregistered = false;
    return async () => {
      if (unregistered) return;
      unregistered = true;
      const current = readRecords(commonDir).find((candidate) => candidate.id === id);
      if (current !== undefined) removeRecord(current, commonDir);
    };
  };

  const snapshot = async (readOptions?: RegistryReadOptions): Promise<Array<AgentProcessRecord>> =>
    read(readOptions).records;

  const closeWorktree = (worktreePath: string): Promise<WorktreeClosureLease> =>
    closeWorktreeGate({ worktreePath, processOps, commonDirResolver: resolveCommonDir });

  const status = async (readOptions?: RegistryReadOptions): Promise<Array<AgentProcessStatus>> => {
    const { records } = read(readOptions);
    const results = await mapInBatches(records, async (record) => {
      const inspection = await processOps.inspect(record.pid);
      return { record, inspection, result: describeInspection(record, inspection) };
    });
    const runningPids = results
      .filter(({ result }) => result.state === "running")
      .map(({ record }) => record.pid);
    const metrics: ReadonlyMap<number, ProcessMetrics> = await processOps.metrics(runningPids);
    return mapInBatches(results, async ({ record }) => {
      const finalResult = describeInspection(record, await processOps.inspect(record.pid));
      return {
        process: record,
        ...finalResult,
        ...(finalResult.state === "running" ? metrics.get(record.pid) : {}),
      };
    });
  };

  const stop = async (worktreePath: string, stopOptions: StopOptions = {}): Promise<StopResult> => {
    const normalizedPath = normalizedWorktreePath(worktreePath);
    const { commonDir, records } = read({ worktreePath: normalizedPath });
    const selected = records.filter(
      (record) =>
        (stopOptions.sessionId === undefined || record.sessionId === stopOptions.sessionId) &&
        (stopOptions.ownerPid === undefined || record.ownerPid === stopOptions.ownerPid),
    );
    return stopRecords({
      records: selected,
      commonDir,
      processOps,
      worktreePath: normalizedPath,
      ...(stopOptions.graceMs === undefined ? {} : { graceMs: stopOptions.graceMs }),
      ...(stopOptions.print === undefined ? {} : { print: stopOptions.print }),
      readCurrentRecords: async () =>
        readRecords(commonDir).filter(
          (record) =>
            record.worktreePath === normalizedPath &&
            (stopOptions.sessionId === undefined || record.sessionId === stopOptions.sessionId) &&
            (stopOptions.ownerPid === undefined || record.ownerPid === stopOptions.ownerPid),
        ),
    });
  };

  const reap = async (reapOptions: ReapOptions = {}): Promise<ReapResult> => {
    const commonDir =
      reapOptions.commonDir === undefined
        ? resolveCommonDir(process.cwd())
        : canonicalDirectory(reapOptions.commonDir);
    const records = readRecords(commonDir);
    const ended = async (record: AgentProcessRecord): Promise<boolean> => {
      const sessionEnded =
        record.sessionId === undefined
          ? false
          : reapOptions.isSessionEnded === undefined
            ? (reapOptions.finishedSessionIds ?? []).includes(record.sessionId)
            : await reapOptions.isSessionEnded(record.sessionId, record.worktreePath);
      const worktreeGone = !NodeFS.existsSync(record.worktreePath);
      const ownerInspection =
        record.ownerPid === undefined || record.ownerIdentity === undefined
          ? undefined
          : await processOps.inspect(record.ownerPid);
      const ownerEnded =
        ownerInspection?.state === "missing" ||
        (ownerInspection?.state === "running" &&
          !sameIdentity(ownerInspection.identity, record.ownerIdentity!));
      return sessionEnded || worktreeGone || ownerEnded;
    };
    const candidates: Array<AgentProcessRecord> = [];
    for (const record of records) if (await ended(record)) candidates.push(record);
    const result = await stopRecords({
      records: candidates,
      commonDir,
      processOps,
      ...(reapOptions.graceMs === undefined ? {} : { graceMs: reapOptions.graceMs }),
      ...(reapOptions.print === undefined ? {} : { print: reapOptions.print }),
      stillEligible: ended,
      readCurrentRecords: async () => {
        const current = readRecords(commonDir);
        const selected: Array<AgentProcessRecord> = [];
        for (const record of current) if (await ended(record)) selected.push(record);
        return selected;
      },
    });
    return { ...result, considered: candidates.length };
  };

  return { registerProcess, closeWorktree, snapshot, status, stop, reap };
};

const validateRegistration = (input: RegisterProcessInput): void => {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 1) {
    throw new Error("pid must be an integer greater than 1");
  }
  if (
    input.ownerPid !== undefined &&
    (!Number.isSafeInteger(input.ownerPid) || input.ownerPid <= 1)
  ) {
    throw new Error("ownerPid must be an integer greater than 1");
  }
  if (input.ports?.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("ports must be integers between 1 and 65535");
  }
};

const assertSameOwnership = (
  input: RegisterProcessInput,
  existing: AgentProcessRecord | undefined,
): void => {
  if (
    existing !== undefined &&
    ((input.sessionId !== undefined &&
      existing.sessionId !== undefined &&
      input.sessionId !== existing.sessionId) ||
      (input.ownerPid !== undefined &&
        existing.ownerPid !== undefined &&
        input.ownerPid !== existing.ownerPid))
  ) {
    throw new Error(`pid ${input.pid} is already registered to a different session or owner`);
  }
};

export const resolveCommonDir = resolveGitCommonDir;

const defaultRegistry = createAgentProcessRegistry();

export const registerProcess = defaultRegistry.registerProcess;
export const closeWorktree = defaultRegistry.closeWorktree;
export const snapshot = defaultRegistry.snapshot;
export const status = defaultRegistry.status;
export const stop = defaultRegistry.stop;
export const reap = defaultRegistry.reap;
