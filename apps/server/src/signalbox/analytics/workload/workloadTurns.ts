/**
 * Folds a turn's run, command, file-change and process observations into the
 * one `workload.turn.completed` record #116's cost replay reads. A turn is a
 * run: one user-to-agent cycle, from its start to its terminal status.
 *
 * Holds no ids or text in what it returns beyond what the caller hashes:
 * commands are reduced to a category and seconds here.
 *
 * @module workloadTurns
 */
import type {
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { classifyCommand, COMMAND_CATEGORIES, type CommandCategory } from "./commandCategory.ts";
import type { AttributionTurn, ThreadUsage } from "./processAttribution.ts";

export type TurnOutcome = "completed" | "interrupted" | "error";

export interface CompletedTurn {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  readonly provider: ProviderDriverKind | undefined;
  readonly model: string;
  readonly outcome: TurnOutcome;
  readonly durationSeconds: number;
  readonly concurrentTurnsAtStart: number;
  readonly commandCounts: Readonly<Record<CommandCategory, number>>;
  readonly commandSeconds: Readonly<Record<CommandCategory, number>>;
  readonly fileChangeBatches: number;
  /** Absent when no sample could be charged to this turn alone. */
  readonly process:
    | {
        readonly cpuSeconds: number;
        readonly peakRssBytes: number;
        readonly samples: number;
      }
    | undefined;
}

interface ActiveTurn {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  readonly directory: string | undefined;
  readonly requestedAtMs: number;
  readonly concurrentTurnsAtStart: number;
  provider: ProviderDriverKind | undefined;
  readonly countedItems: Set<string>;
  readonly commandCounts: Record<CommandCategory, number>;
  readonly commandMs: Record<CommandCategory, number>;
  fileChangeBatches: number;
  cpuMs: number;
  peakRssBytes: number;
  samples: number;
}

const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "starting",
  "running",
  "waiting",
]);
const TERMINAL_ITEM_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const MAX_FINISHED_RUNS = 4_096;

/** Started and not yet terminal: a turn in flight. */
export const isWorkingRun = (run: OrchestrationV2Run) =>
  ACTIVE_RUN_STATUSES.has(run.status) && run.startedAt !== null;

const outcomeOf = (status: OrchestrationV2Run["status"]): TurnOutcome =>
  status === "completed" ? "completed" : status === "failed" ? "error" : "interrupted";

const byCategory = (value: (category: CommandCategory) => number) =>
  Object.fromEntries(COMMAND_CATEGORIES.map((category) => [category, value(category)])) as Record<
    CommandCategory,
    number
  >;

const seconds = (ms: number) => Math.round(ms / 100) / 10;

const elapsedMs = (from: DateTime.Utc | null, to: DateTime.Utc | null) =>
  from === null || to === null
    ? 0
    : Math.max(0, DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from));

export function makeWorkloadTurns() {
  const active = new Map<RunId, ActiveTurn>();
  // Terminal run updates can repeat; each turn is reported once.
  const finished = new Set<RunId>();

  const has = (runId: RunId) => active.has(runId) || finished.has(runId);
  const isTracking = (runId: RunId) => active.has(runId);
  const size = () => active.size;

  /** A run became active. Later calls for the same run are ignored. */
  const start = (input: {
    readonly run: OrchestrationV2Run;
    readonly projectId: ProjectId | undefined;
    readonly directory: string | undefined;
  }) => {
    if (has(input.run.id)) return;
    active.set(input.run.id, {
      threadId: input.run.threadId,
      projectId: input.projectId,
      directory: input.directory,
      requestedAtMs: DateTime.toEpochMillis(input.run.requestedAt),
      concurrentTurnsAtStart: active.size + 1,
      provider: undefined,
      countedItems: new Set(),
      commandCounts: byCategory(() => 0),
      commandMs: byCategory(() => 0),
      fileChangeBatches: 0,
      cpuMs: 0,
      peakRssBytes: 0,
      samples: 0,
    });
  };

  const noteProvider = (runId: RunId, provider: ProviderDriverKind) => {
    const turn = active.get(runId);
    if (turn !== undefined) turn.provider ??= provider;
  };

  /** A turn item changed; commands and file changes count once they end. */
  const item = (turnItem: OrchestrationV2TurnItem) => {
    if (turnItem.runId === null || !TERMINAL_ITEM_STATUSES.has(turnItem.status)) return;
    const turn = active.get(turnItem.runId);
    if (turn === undefined || turn.countedItems.has(turnItem.id)) return;
    if (turnItem.type === "command_execution") {
      turn.countedItems.add(turnItem.id);
      const category = classifyCommand(turnItem.input);
      turn.commandCounts[category] += 1;
      turn.commandMs[category] += elapsedMs(turnItem.startedAt, turnItem.completedAt);
    } else if (turnItem.type === "file_change" && turnItem.status === "completed") {
      turn.countedItems.add(turnItem.id);
      turn.fileChangeBatches += 1;
    }
  };

  /** Runs in flight, for process attribution. */
  const attributionTurns = (): ReadonlyArray<AttributionTurn> =>
    [...active.values()].map((turn) => ({
      threadId: turn.threadId,
      directory: turn.directory,
      requestedAtMs: turn.requestedAtMs,
    }));

  /** Charges one process snapshot's usage, keyed by thread, to its turn. */
  const processSample = (usage: ReadonlyMap<ThreadId, ThreadUsage>) => {
    for (const turn of active.values()) {
      const sample = usage.get(turn.threadId);
      if (sample === undefined) continue;
      turn.cpuMs += sample.cpuMs;
      turn.peakRssBytes = Math.max(turn.peakRssBytes, sample.residentBytes);
      turn.samples += 1;
    }
  };

  /** The run reached a terminal status; returns its record once. */
  const finish = (run: OrchestrationV2Run): CompletedTurn | undefined => {
    const turn = active.get(run.id);
    if (turn === undefined) return undefined;
    active.delete(run.id);
    finished.add(run.id);
    if (finished.size > MAX_FINISHED_RUNS) {
      const oldest = finished.values().next().value;
      if (oldest !== undefined) finished.delete(oldest);
    }
    return {
      threadId: turn.threadId,
      projectId: turn.projectId,
      provider: turn.provider,
      model: run.modelSelection.model,
      outcome: outcomeOf(run.status),
      durationSeconds: seconds(elapsedMs(run.startedAt, run.completedAt)),
      concurrentTurnsAtStart: turn.concurrentTurnsAtStart,
      commandCounts: turn.commandCounts,
      commandSeconds: byCategory((category) => seconds(turn.commandMs[category])),
      fileChangeBatches: turn.fileChangeBatches,
      process:
        turn.samples === 0
          ? undefined
          : {
              cpuSeconds: seconds(turn.cpuMs),
              peakRssBytes: turn.peakRssBytes,
              samples: turn.samples,
            },
    };
  };

  return {
    has,
    isTracking,
    size,
    start,
    noteProvider,
    item,
    attributionTurns,
    processSample,
    finish,
  };
}
