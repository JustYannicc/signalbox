import type { TerminalEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import type { TerminalReport } from "@signalbox/runner-protocol/TerminalProtocol";

import type { TerminalCommandRecord, TerminalRecord } from "./TerminalStore.ts";
import { terminalHistoryTail } from "./terminalHistory.ts";

export const terminalHoldsMachine = (record: TerminalRecord) =>
  record.status === "starting" ||
  record.status === "running" ||
  record.status === "closing" ||
  (record.status === "error" && !record.processLost);

export const snapshot = (record: TerminalRecord): TerminalSessionSnapshot => ({
  generation: record.generation,
  threadId: record.threadId,
  terminalId: record.terminalId,
  cwd: record.cwd,
  worktreePath: record.worktreePath,
  status: record.status === "closing" || record.status === "closed" ? "exited" : record.status,
  pid: record.pid,
  history: record.history,
  exitCode: record.exitCode,
  exitSignal: record.exitSignal,
  label: record.label,
  updatedAt: record.updatedAt,
  sequence: record.revision,
});

export const afterResult = (
  record: TerminalRecord,
  report: Extract<TerminalReport, { type: "result" }>,
  command: TerminalCommandRecord,
  now: string,
): { readonly record: TerminalRecord; readonly event: TerminalEvent | null } => {
  if (report.result.type === "opened") {
    if (record.status !== "starting") return { record, event: null };
    const opened = report.result.snapshot;
    const next: TerminalRecord = {
      ...record,
      status: opened.status,
      pid: opened.pid,
      label: opened.label,
      history:
        (opened.sequence ?? 0) >= record.sequence
          ? terminalHistoryTail(opened.history)
          : record.history,
      sequence: Math.max(record.sequence, opened.sequence ?? 0),
      exitCode: opened.exitCode,
      exitSignal: opened.exitSignal,
      updatedAt: now,
    };
    return {
      record: next,
      event: {
        type: next.generation > 1 ? "restarted" : "started",
        threadId: next.threadId,
        terminalId: next.terminalId,
        sequence: next.sequence,
        snapshot: snapshot(next),
      },
    };
  }
  if (report.result.type === "closed") {
    if (record.status === "closed") return { record, event: null };
    const next: TerminalRecord = {
      ...record,
      status: "closed",
      pid: null,
      hasRunningSubprocess: false,
      history: record.deleteHistory ? "" : record.history,
      updatedAt: now,
    };
    return {
      record: next,
      event: {
        type: "closed",
        threadId: next.threadId,
        terminalId: next.terminalId,
        sequence: next.sequence,
      },
    };
  }
  if (report.result.type === "error") {
    const next: TerminalRecord =
      command.kind === "open" || command.kind === "close"
        ? {
            ...record,
            status: "error",
            pid: null,
            processLost: true,
            hasRunningSubprocess: false,
            updatedAt: now,
          }
        : record;
    return {
      record: next,
      event: {
        type: "error",
        threadId: next.threadId,
        terminalId: next.terminalId,
        sequence: next.sequence,
        message: report.result.message,
      },
    };
  }
  return { record, event: null };
};

export const afterEvent = (
  record: TerminalRecord,
  report: Extract<TerminalReport, { type: "event" }>,
  now: string,
): { readonly record: TerminalRecord; readonly event: TerminalEvent } => {
  const event = report.event;
  const base = {
    threadId: record.threadId,
    terminalId: record.terminalId,
    sequence: report.sequence,
  };
  const current = { ...record, sequence: report.sequence, updatedAt: now };
  switch (event.type) {
    case "output":
      return {
        record: { ...current, history: terminalHistoryTail(record.history + event.data) },
        event: { ...base, type: "output", data: event.data },
      };
    case "cleared":
      return { record: { ...current, history: "" }, event: { ...base, type: "cleared" } };
    case "error":
      return {
        record: { ...current, status: record.status === "closing" ? "closing" : "error" },
        event: { ...base, type: "error", message: event.message },
      };
    case "activity":
      return {
        record: {
          ...current,
          hasRunningSubprocess: event.hasRunningSubprocess,
          label: event.label,
        },
        event: { ...base, ...event },
      };
    case "exit":
      return {
        record: {
          ...current,
          status: record.status === "closing" ? "closing" : "exited",
          pid: null,
          hasRunningSubprocess: false,
          exitCode: event.exitCode,
          exitSignal: event.exitSignal,
        },
        event: { ...base, type: "exited", exitCode: event.exitCode, exitSignal: event.exitSignal },
      };
    case "closed":
      return {
        record: {
          ...current,
          status: "closed",
          pid: null,
          hasRunningSubprocess: false,
          history: record.deleteHistory ? "" : record.history,
        },
        event: { ...base, type: "closed" },
      };
  }
};
