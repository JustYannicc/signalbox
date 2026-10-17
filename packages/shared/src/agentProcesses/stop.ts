// @effect-diagnostics nodeBuiltinImport:off - prints stop candidates and signals exact registered PIDs.
import { describeInspection } from "./inspection.ts";
import { removeRecord } from "./storage.ts";
import type { AgentProcessRecord, ProcessOps, ProcessSurvivor, StopResult } from "./types.ts";

const DEFAULT_GRACE_MS = 3_000;
const MAX_GRACE_MS = 10_000;

const defaultPrint = (text: string): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
  });

const survivorFor = (record: AgentProcessRecord, reason: string): ProcessSurvivor => ({
  pid: record.pid,
  ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
  ...(record.ownerPid === undefined ? {} : { ownerPid: record.ownerPid }),
  reason,
});

const renderCandidates = (
  worktreePath: string | undefined,
  candidates: ReadonlyArray<{ readonly process: AgentProcessRecord; readonly cwd: string }>,
): string => {
  const heading =
    worktreePath === undefined
      ? "Registered process stop candidates:"
      : `Registered process stop candidates for ${worktreePath}:`;
  return [
    heading,
    ...candidates.map(({ process, cwd }) => {
      const details = [
        `pid=${process.pid}`,
        ...(process.sessionId === undefined ? [] : [`session=${process.sessionId}`]),
        ...(process.ownerPid === undefined ? [] : [`owner=${process.ownerPid}`]),
        ...(process.label === undefined ? [] : [`label=${process.label}`]),
        ...(process.ports === undefined || process.ports.length === 0
          ? []
          : [`ports=${process.ports.join(",")}`]),
        `cwd=${cwd}`,
      ];
      return `- ${details.join(" ")}`;
    }),
  ].join("\n");
};

export const stopRecords = async (input: {
  readonly records: ReadonlyArray<AgentProcessRecord>;
  readonly commonDir: string;
  readonly processOps: ProcessOps;
  readonly worktreePath?: string;
  readonly graceMs?: number;
  readonly print?: (text: string) => void | Promise<void>;
  readonly stillEligible?: (record: AgentProcessRecord) => Promise<boolean>;
  readonly readCurrentRecords?: () => Promise<ReadonlyArray<AgentProcessRecord>>;
}): Promise<StopResult> => {
  const candidates: Array<{ readonly process: AgentProcessRecord; readonly cwd: string }> = [];
  const stopped = new Set<number>();
  const removed = new Set<number>();
  const survivors = new Map<number, ProcessSurvivor>();
  const prune = (record: AgentProcessRecord): void => {
    removeRecord(record, input.commonDir);
    removed.add(record.pid);
  };
  const keep = (record: AgentProcessRecord, reason: string): void => {
    survivors.set(record.pid, survivorFor(record, reason));
  };
  const check = async (record: AgentProcessRecord) =>
    describeInspection(record, await input.processOps.inspect(record.pid));
  const canStillStop = async (record: AgentProcessRecord): Promise<boolean> =>
    input.stillEligible === undefined || (await input.stillEligible(record));

  for (const record of input.records) {
    const result = await check(record);
    if (result.state === "running" && result.cwd !== undefined) {
      candidates.push({ process: record, cwd: result.cwd });
    } else if (result.state === "exited" || result.state === "reused") {
      prune(record);
    } else {
      keep(record, result.reason ?? result.state);
    }
  }

  if (candidates.length > 0) {
    await (input.print ?? defaultPrint)(renderCandidates(input.worktreePath, candidates));
  }

  const termSent: Array<AgentProcessRecord> = [];
  for (const candidate of candidates) {
    if (!(await canStillStop(candidate.process))) {
      keep(candidate.process, "owning session resumed before SIGTERM");
      continue;
    }
    const result = await check(candidate.process);
    if (result.state === "exited" || result.state === "reused") {
      prune(candidate.process);
      continue;
    }
    if (result.state !== "running") {
      keep(candidate.process, result.reason ?? result.state);
      continue;
    }
    try {
      input.processOps.sendSignal(candidate.process.pid, "SIGTERM");
      termSent.push(candidate.process);
    } catch (error) {
      const afterFailure = await check(candidate.process);
      if (afterFailure.state === "exited" || afterFailure.state === "reused") {
        prune(candidate.process);
      } else {
        keep(candidate.process, `SIGTERM failed: ${String(error)}`);
      }
    }
  }

  if (termSent.length > 0) {
    const graceMs = Math.max(0, Math.min(input.graceMs ?? DEFAULT_GRACE_MS, MAX_GRACE_MS));
    await input.processOps.wait(graceMs);
  }

  const killSent: Array<AgentProcessRecord> = [];
  for (const record of termSent) {
    if (!(await canStillStop(record))) {
      keep(record, "owning session resumed before SIGKILL");
      continue;
    }
    const result = await check(record);
    if (result.state === "exited" || result.state === "reused") {
      prune(record);
      stopped.add(record.pid);
      continue;
    }
    if (result.state !== "running") {
      keep(record, result.reason ?? result.state);
      continue;
    }
    try {
      input.processOps.sendSignal(record.pid, "SIGKILL");
      killSent.push(record);
    } catch (error) {
      const afterFailure = await check(record);
      if (afterFailure.state === "exited" || afterFailure.state === "reused") {
        prune(record);
        stopped.add(record.pid);
      } else {
        keep(record, `SIGKILL failed: ${String(error)}`);
      }
    }
  }

  if (killSent.length > 0) await input.processOps.wait(100);
  for (const record of killSent) {
    const result = await check(record);
    if (result.state === "exited" || result.state === "reused") {
      prune(record);
      stopped.add(record.pid);
    } else {
      keep(record, result.reason ?? "process remains after SIGKILL");
    }
  }

  const initialIds = new Set(input.records.map((record) => record.id));
  for (const record of (await input.readCurrentRecords?.()) ?? []) {
    if ((!initialIds.has(record.id) || removed.has(record.pid)) && !survivors.has(record.pid)) {
      keep(record, "registered during stop");
    }
  }

  return {
    candidates: candidates.map(({ process }) => process.pid),
    stopped: [...stopped],
    removed: [...removed],
    survivors: [...survivors.values()],
  };
};
