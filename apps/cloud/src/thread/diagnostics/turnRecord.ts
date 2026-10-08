import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { classifyCommand } from "@t3tools/shared/commandCategory";
import {
  byCategory,
  elapsedMs,
  outcomeOf,
  seconds,
  secondsSincePreviousTurn,
  TERMINAL_ITEM_STATUSES,
} from "@t3tools/shared/workloadUsage";
import * as DateTime from "effect/DateTime";

import { driverFor } from "../providerCatalog.ts";
import type { MachineBackendShape } from "../runner/MachineBackend.ts";
import type { LogLine, MachineSession, RunDiagnostics } from "./DiagnosticsStore.ts";

/**
 * Pure builders over a turn's events and what diagnostics collected: the
 * diagnostic record a person reads to see why a turn did what it did, and the
 * analytics properties #116's cost replay reads. Analytics carry no content,
 * paths or command text: commands become a category and seconds here, and ids
 * arrive already hashed. The turn's workload fields are reduced the way
 * `workload.turn.completed`'s are (`@t3tools/shared/workloadUsage`).
 */

type Projection = OrchestrationV2ThreadProjection;

const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));
const isoMs = (ms: number | null) =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));
export const epochMs = (value: DateTime.Utc | null) =>
  value === null ? null : DateTime.toEpochMillis(value);

const itemsOf = (projection: Projection, run: OrchestrationV2Run) =>
  projection.turnItems.filter((item) => item.runId === run.id);

const failureOf = (items: ReadonlyArray<OrchestrationV2TurnItem>) => {
  const error = items.findLast((item) => item.type === "error");
  return error?.type === "error"
    ? { class: error.failure.class, message: error.failure.message, code: error.failure.code }
    : null;
};

/** A turn in the diagnostics list: enough to pick the one to open. */
export const turnSummary = (projection: Projection, run: OrchestrationV2Run, traceId: string) => ({
  traceId,
  runId: run.id,
  ordinal: run.ordinal,
  status: run.status,
  failure: failureOf(itemsOf(projection, run)),
  requestedAt: iso(run.requestedAt),
});
export type TurnSummary = ReturnType<typeof turnSummary>;

const sessionRecord = (session: MachineSession) => ({
  generation: session.generation,
  backend: session.backend,
  shape: session.shape,
  machineId: session.machineId,
  image: session.image,
  runner: session.runner,
  wake: session.wake,
  requestedAt: isoMs(session.requestedAt),
  readyAt: isoMs(session.readyAt),
  firstEventAt: isoMs(session.firstEventAt),
  connections: session.connections,
  usage: session.usage,
  endedAt: isoMs(session.endedAt),
  stopReason: session.stopReason,
  stopDetail: session.stopDetail,
});

/** Everything that explains one turn, without a shell on its machine. */
export function turnRecord(input: {
  readonly projection: Projection;
  readonly run: OrchestrationV2Run;
  readonly traceId: string;
  readonly diagnostics: RunDiagnostics | null;
  readonly sessions: ReadonlyArray<MachineSession>;
  readonly log: ReadonlyArray<LogLine>;
}) {
  const { projection, run, diagnostics } = input;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  return {
    ...turnSummary(projection, run, input.traceId),
    threadId: projection.thread.id,
    provider: run.providerInstanceId,
    model: run.modelSelection.model,
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    machines: input.sessions.map(sessionRecord),
    recoveries: diagnostics?.recoveries ?? 0,
    usage: {
      cpuSeconds: diagnostics?.cpuSeconds ?? null,
      memoryPeakBytes: diagnostics?.memoryPeakBytes ?? null,
    },
    modelRequests: diagnostics?.modelRequests ?? 0,
    modelTokens: diagnostics?.modelTokens ?? {},
    // The harness's own session, as the thread knows it.
    refs: {
      providerSessionId: providerThread?.providerSessionId ?? null,
      nativeThreadRef: providerThread?.nativeThreadRef ?? null,
      nativeConversationHeadRef: providerThread?.nativeConversationHeadRef ?? null,
    },
    log: input.log.map((line) => ({ ...line, at: isoMs(line.at) })),
  };
}
export type TurnRecord = ReturnType<typeof turnRecord>;

/** The turn's command work by category, and its file-change batches. */
function workOf(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  const commandCounts = byCategory(() => 0);
  const commandMs = byCategory(() => 0);
  let fileChangeBatches = 0;
  for (const item of items) {
    if (!TERMINAL_ITEM_STATUSES.has(item.status)) continue;
    if (item.type === "command_execution") {
      const category = classifyCommand(item.input);
      commandCounts[category] += 1;
      commandMs[category] += elapsedMs(item.startedAt, item.completedAt);
    } else if (item.type === "file_change" && item.status === "completed") {
      fileChangeBatches += 1;
    }
  }
  return {
    commandCounts,
    commandSeconds: byCategory((category) => seconds(commandMs[category])),
    fileChangeBatches,
  };
}

/**
 * `cloud.turn.completed`: `workload.turn.completed`'s fields plus the cloud's
 * own. Stores that do not exist yet (drives #131, session rows #132, previews
 * #136) did no work for the turn, so they report zero.
 */
export function turnCompletedProperties(input: {
  readonly projection: Projection;
  readonly run: OrchestrationV2Run;
  readonly diagnostics: RunDiagnostics | null;
  readonly backend: MachineBackendShape["kind"] | null;
  readonly threadHash: string;
  readonly projectHash: string;
}) {
  const { projection, run, diagnostics } = input;
  const previous = projection.runs
    .filter((candidate) => candidate.ordinal < run.ordinal && candidate.completedAt !== null)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  const started = epochMs(run.startedAt);
  const previousEnded = epochMs(previous?.completedAt ?? null);
  return {
    threadHash: input.threadHash,
    projectHash: input.projectHash,
    provider: driverFor(run.providerInstanceId),
    model: run.modelSelection.model,
    outcome: outcomeOf(run.status),
    durationSeconds: seconds(elapsedMs(run.startedAt, run.completedAt)),
    secondsSincePreviousTurn:
      previousEnded === null || started === null
        ? undefined
        : secondsSincePreviousTurn(previousEnded, started),
    // A thread's machine runs one turn at a time.
    concurrentTurnsAtStart: 1,
    ...workOf(itemsOf(projection, run)),
    processCpuSeconds: diagnostics?.cpuSeconds ?? undefined,
    processPeakRssBytes: diagnostics?.memoryPeakBytes ?? undefined,
    processSamples: diagnostics?.usageSamples ?? 0,
    backend: input.backend ?? undefined,
    gitStoreOperations: { wipCommits: 0, checkpoints: 0, fetches: 0 },
    gitStoreBytes: 0,
    sessionStoreRows: 0,
    sessionStoreBytes: 0,
    modelRequests: diagnostics?.modelRequests ?? 0,
    modelTokens: diagnostics?.modelTokens ?? {},
    previewSeconds: 0,
    recoveryCount: diagnostics?.recoveries ?? 0,
  };
}

/** `cloud.machine.session`: one awake period of a thread's machine. */
export function machineSessionProperties(session: MachineSession, threadHash: string) {
  const ended = session.endedAt ?? session.requestedAt;
  const since = (at: number | null) => (at === null ? undefined : at - session.requestedAt);
  return {
    threadHash,
    backend: session.backend,
    shape: session.shape ?? undefined,
    // No backend reports a region yet; launch is EU-only (#122).
    region: null,
    awakeSeconds: seconds(ended - session.requestedAt),
    idleTailSeconds: seconds(session.idleTailMs ?? 0),
    cpuSeconds: session.usage?.cpuSeconds ?? undefined,
    memoryPeakBytes: session.usage?.memoryPeakBytes ?? undefined,
    memoryAverageBytes: session.usage?.memoryAverageBytes ?? undefined,
    diskUsedBytes: session.usage?.diskUsedBytes ?? undefined,
    egressBytes: session.usage?.egressBytes ?? undefined,
    wakeKind: session.wake ?? undefined,
    wakeToReadyMs: since(session.readyAt),
    wakeToFirstEventMs: since(session.firstEventAt),
    // Dependency caches arrive with #133; until then nothing can hit.
    dependencyCacheHit: null,
    stopReason: session.stopReason ?? "error",
    turns: session.runs.length,
  };
}
