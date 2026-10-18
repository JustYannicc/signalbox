import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import type {
  TerminalCommand,
  TerminalEvent,
  TerminalReport,
} from "@signalbox/runner-protocol/TerminalProtocol";

const EVENT_BACKLOG_BYTE_LIMIT = 4 * 1024 * 1024;
const EVENT_BACKLOG_COUNT_LIMIT = 2048;
const EVENT_OUTPUT_CHUNK_BYTES = 16 * 1024;
const SNAPSHOT_HISTORY_CHAR_LIMIT = 128 * 1024;
const CONTROL_RECEIPT_LIMIT = 256;
const WRITE_RECEIPT_LIMIT = 65_536;
const encoder = new TextEncoder();

export type TerminalReportEvent = Extract<TerminalReport, { readonly type: "event" }>;
export type TerminalReportResult = Extract<TerminalReport, { readonly type: "result" }>;

export interface ControlReceipt {
  readonly fingerprint: string;
  readonly report: TerminalReportResult;
}

export interface TerminalState {
  readonly terminalId: string;
  readonly generation: number;
  readonly leaseGeneration: number;
  managerSequence: number;
  reportSequence: number;
  snapshot: TerminalSessionSnapshot;
  ready: boolean;
  closed: boolean;
  exited: boolean;
  unsubscribe: (() => void) | null;
  pendingReports: Array<TerminalReportEvent>;
  readonly controlReceipts: Map<string, ControlReceipt>;
}

interface WriteResult {
  readonly terminalId: string;
  readonly generation: number;
  readonly commandId: string;
  readonly digest: string;
}

const boundedHistory = (history: string) => history.slice(-SNAPSHOT_HISTORY_CHAR_LIMIT);

const splitOutput = (data: string): ReadonlyArray<string> => {
  if (encoder.encode(data).byteLength <= EVENT_OUTPUT_CHUNK_BYTES) return [data];

  const chunks: Array<string> = [];
  let chunk = "";
  let bytes = 0;
  for (const character of data) {
    const size = encoder.encode(character).byteLength;
    if (chunk.length > 0 && bytes + size > EVENT_OUTPUT_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk.length > 0 || data.length === 0) chunks.push(chunk);
  return chunks;
};

export const eventFor = (
  event: Exclude<TerminalAttachStreamEvent, { readonly type: "snapshot" }>,
): TerminalEvent | null => {
  switch (event.type) {
    case "output":
      return { type: "output", data: event.data };
    case "exited":
      return {
        type: "exit",
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
      };
    case "closed":
    case "restarted":
      return null;
    case "cleared":
      return { type: "cleared" };
    case "error":
      return { type: "error", message: event.message.slice(0, 2_000) };
    case "activity":
      return {
        type: "activity",
        hasRunningSubprocess: event.hasRunningSubprocess,
        label: event.label.slice(0, 128),
      };
  }
};

const updateSnapshot = (
  state: TerminalState,
  event: TerminalEvent,
  sequence: number,
  now: string,
) => {
  const snapshot = { ...state.snapshot, sequence, updatedAt: now };
  switch (event.type) {
    case "output":
      snapshot.history = boundedHistory(snapshot.history + event.data);
      break;
    case "cleared":
      snapshot.history = "";
      break;
    case "activity":
      snapshot.label = event.label;
      break;
    case "exit":
      snapshot.status = "exited";
      snapshot.pid = null;
      snapshot.exitCode = event.exitCode;
      snapshot.exitSignal = event.exitSignal;
      break;
    case "error":
      snapshot.status = "error";
      snapshot.pid = null;
      break;
    case "closed":
      snapshot.status = "exited";
      snapshot.pid = null;
      break;
  }
  state.snapshot = snapshot;
};

export const publicSnapshot = (snapshot: TerminalSessionSnapshot): TerminalSessionSnapshot => ({
  ...snapshot,
  cwd: ".",
  worktreePath: null,
});

/** Bounds terminal replay history and input receipts. */
export class RunnerTerminalReports {
  private eventBacklog: Array<TerminalReportEvent> = [];
  private eventBacklogBytes = 0;
  private readonly writes = new Map<string, WriteResult>();
  private readonly writeCounts = new Map<string, number>();

  private generationKey(terminalId: string, generation: number) {
    return `${terminalId}\0${generation}`;
  }

  private writeKey(terminalId: string, generation: number, commandId: string) {
    return `${terminalId}\0${generation}\0${commandId}`;
  }

  private reportBytes(report: TerminalReportEvent) {
    return encoder.encode(JSON.stringify(report)).byteLength;
  }

  removeEvents(terminalId: string, generation?: number) {
    this.eventBacklog = this.eventBacklog.filter((report) => {
      const remove =
        report.terminalId === terminalId &&
        (generation === undefined || report.generation === generation);
      if (remove) this.eventBacklogBytes -= this.reportBytes(report);
      return !remove;
    });
  }

  removeWrites(terminalId: string, generation: number) {
    for (const [key, result] of this.writes) {
      if (result.terminalId === terminalId && result.generation === generation) {
        this.writes.delete(key);
        const generationKey = this.generationKey(result.terminalId, result.generation);
        const count = this.writeCounts.get(generationKey);
        if (count === 1) this.writeCounts.delete(generationKey);
        else if (count !== undefined) this.writeCounts.set(generationKey, count - 1);
      }
    }
  }

  checkWrite(
    command: Extract<TerminalCommand, { readonly type: "write" }>,
    fingerprint: string,
  ): "new" | "same" | "conflict" | "limit" {
    const prior = this.writes.get(
      this.writeKey(command.terminalId, command.generation, command.commandId),
    );
    if (prior !== undefined) return prior.digest === fingerprint ? "same" : "conflict";
    return (this.writeCounts.get(this.generationKey(command.terminalId, command.generation)) ??
      0) >= WRITE_RECEIPT_LIMIT
      ? "limit"
      : "new";
  }

  rememberWrite(
    command: Extract<TerminalCommand, { readonly type: "write" }>,
    fingerprint: string,
  ) {
    this.writes.set(this.writeKey(command.terminalId, command.generation, command.commandId), {
      terminalId: command.terminalId,
      generation: command.generation,
      commandId: command.commandId,
      digest: fingerprint,
    });
    const generationKey = this.generationKey(command.terminalId, command.generation);
    this.writeCounts.set(generationKey, (this.writeCounts.get(generationKey) ?? 0) + 1);
  }

  rememberControlReceipt(state: TerminalState, requestId: string, receipt: ControlReceipt) {
    state.controlReceipts.set(requestId, receipt);
    while (state.controlReceipts.size > CONTROL_RECEIPT_LIMIT) {
      const oldest = state.controlReceipts.keys().next().value;
      if (oldest === undefined) break;
      state.controlReceipts.delete(oldest);
    }
  }

  appendEvent(
    state: TerminalState,
    event: TerminalEvent,
    terminals: Iterable<TerminalState>,
    now: string,
  ): ReadonlyArray<TerminalReportEvent> {
    const chunks = event.type === "output" ? splitOutput(event.data) : [null];
    const reports = chunks.map((chunk) => {
      state.reportSequence += 1;
      const reportEvent: TerminalEvent = chunk === null ? event : { type: "output", data: chunk };
      updateSnapshot(state, reportEvent, state.reportSequence, now);
      const report: TerminalReportEvent = {
        type: "event",
        terminalId: state.terminalId,
        generation: state.generation,
        leaseGeneration: state.leaseGeneration,
        sequence: state.reportSequence,
        event: reportEvent,
      };
      this.eventBacklog.push(report);
      this.eventBacklogBytes += this.reportBytes(report);
      if (!state.ready) state.pendingReports.push(report);
      return report;
    });

    while (
      this.eventBacklog.length > EVENT_BACKLOG_COUNT_LIMIT ||
      this.eventBacklogBytes > EVENT_BACKLOG_BYTE_LIMIT
    ) {
      const removed = this.eventBacklog.shift();
      if (removed === undefined) break;
      this.eventBacklogBytes -= this.reportBytes(removed);
      for (const terminal of terminals) {
        terminal.pendingReports = terminal.pendingReports.filter((pending) => pending !== removed);
      }
    }

    return state.ready ? reports : [];
  }

  snapshots(terminals: Iterable<TerminalState>): ReadonlyArray<TerminalReport> {
    return [...terminals].map((state) => ({
      type: "snapshot",
      terminalId: state.terminalId,
      generation: state.generation,
      leaseGeneration: state.leaseGeneration,
      snapshot: {
        ...state.snapshot,
        history: boundedHistory(state.snapshot.history),
        sequence: state.reportSequence,
      },
    }));
  }

  replay(terminals: Iterable<TerminalState>): ReadonlyArray<TerminalReport> {
    return [...this.snapshots(terminals), ...this.eventBacklog];
  }
}
