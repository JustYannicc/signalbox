import { workflowStopResult } from "../workflowControl.ts";
import type {
  RunnerItem,
  RunnerMessageInput,
  RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import {
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2AppThread,
  OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderTurnId,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { isHarnessInstance, runnerInstanceFor } from "../../models/ModelRouting.ts";
import {
  activeRun,
  finishRunEvents,
  isTerminalRunStatus,
  providerThreadFor,
  type RunEnding,
} from "../runLifecycle.ts";
import { isLiveRun } from "../runState.ts";
import {
  attemptEvent,
  type DecisionContext,
  itemOrdinal,
  nodeEvent,
  providerSessionEvent,
  providerThreadEvent,
  runEvent,
  turnItemEvent,
} from "../threadEvents.ts";
import { applyEvents } from "../threadProjection.ts";
import { checkpointEvents, dependencyProgressEvents, noticeEvents } from "../driveEvents.ts";
import {
  ERROR_ITEM_BAND_POSITION,
  appThreadCreated,
  appThreadCreatedId,
  type Json,
  providerEventThreadId,
  recordedEvents,
  stringField,
  systemNoticeEvents,
} from "./runnerEvents.ts";
import type { NativeChildPending, ProviderRunnerItem } from "./nativeChildBatch.ts";

/**
 * What a Runner's reports mean for a thread, decided from the projection
 * alone: the turn it should run, the events each reported item becomes, and
 * how a run ends when no machine shows up. Pure, like the decider.
 */

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;

export interface NativeChildBatch {
  readonly childThreadId: ThreadId;
  readonly parentRunId: RunId;
  readonly appThread: OrchestrationV2AppThread;
  readonly attestation: OrchestrationV2Subagent;
  readonly items: ReadonlyArray<ProviderRunnerItem>;
}

export interface NativeChildDiagnostic {
  readonly runId: RunId;
  readonly reason: NativeChildFailure;
  readonly count: number;
}

interface NativeChildCandidate {
  readonly childThreadId: ThreadId;
  readonly parentRunId: RunId;
  appThread?: OrchestrationV2AppThread;
  createdByDriver?: string;
  readonly items: Array<ProviderRunnerItem>;
  readonly drivers: Set<string>;
  creationDecode: boolean;
  invalidDriver: boolean;
  materialized: boolean;
}

type NativeChildFailure =
  | "missing_attestation"
  | "attestation_thread_mismatch"
  | "attestation_run_mismatch"
  | "attestation_origin_mismatch"
  | "attestation_child_mismatch"
  | "invalid_driver"
  | "missing_creation"
  | "creation_decode"
  | "creation_id_mismatch"
  | "creation_creator_mismatch"
  | "creation_source_mismatch"
  | "creation_project_mismatch"
  | "creation_parent_mismatch"
  | "creation_relationship_mismatch"
  | "creation_root_mismatch"
  | "creation_fork_origin_mismatch"
  | "creation_node_mismatch"
  | "creation_provider_mismatch"
  | "creation_model_mismatch"
  | "creation_provider_thread_mismatch";

const nativeChildFailure = (
  parent: Projection,
  candidate: NativeChildCandidate,
  subagent: OrchestrationV2Subagent,
): NativeChildFailure | null => {
  if (subagent.threadId !== parent.thread.id) return "attestation_thread_mismatch";
  if (subagent.runId !== candidate.parentRunId) return "attestation_run_mismatch";
  if (subagent.origin !== "provider_native") return "attestation_origin_mismatch";
  if (subagent.childThreadId !== candidate.childThreadId) return "attestation_child_mismatch";
  if (
    candidate.drivers.size === 0 ||
    candidate.invalidDriver ||
    [...candidate.drivers].some((driver) => driver !== subagent.driver) ||
    (candidate.appThread !== undefined && candidate.createdByDriver !== subagent.driver)
  ) {
    return "invalid_driver";
  }
  const appThread = candidate.appThread;
  if (appThread === undefined) {
    return candidate.creationDecode ? "creation_decode" : "missing_creation";
  }
  if (appThread.id !== candidate.childThreadId) return "creation_id_mismatch";
  if (appThread.createdBy !== "agent") return "creation_creator_mismatch";
  if (appThread.creationSource !== "provider") return "creation_source_mismatch";
  if (appThread.projectId !== parent.thread.projectId) return "creation_project_mismatch";
  if (appThread.lineage.parentThreadId !== parent.thread.id) return "creation_parent_mismatch";
  if (appThread.lineage.relationshipToParent !== "subagent") {
    return "creation_relationship_mismatch";
  }
  if (appThread.lineage.rootThreadId !== parent.thread.lineage.rootThreadId) {
    return "creation_root_mismatch";
  }
  if (appThread.forkedFrom?.type !== "node") return "creation_fork_origin_mismatch";
  if (appThread.forkedFrom.nodeId !== subagent.id) return "creation_node_mismatch";
  const instanceId = runnerInstanceFor(subagent.providerInstanceId) ?? subagent.providerInstanceId;
  if (appThread.providerInstanceId !== instanceId) {
    return "creation_provider_mismatch";
  }
  if (appThread.modelSelection.instanceId !== instanceId) {
    return "creation_model_mismatch";
  }
  if (appThread.activeProviderThreadId !== subagent.providerThreadId) {
    return "creation_provider_thread_mismatch";
  }
  return null;
};

const nativeChildMatches = (
  parent: Projection,
  candidate: NativeChildCandidate,
  subagent: OrchestrationV2Subagent,
) => {
  const failure = nativeChildFailure(parent, candidate, subagent);
  return failure === null || failure === "missing_creation" || failure === "creation_decode";
};

/** The live run a Runner drives, if any. */
export const harnessRun = (projection: Projection): Run | undefined => {
  const run = activeRun(projection);
  return run !== undefined && isHarnessInstance(run.providerInstanceId) ? run : undefined;
};

/** Whether `run` waits for a Runner to take it; once one reports it started, none is handed it again. */
export const awaitsHandoff = (run: Run) => run.status === "starting" || run.status === "preparing";

/** A user message as the Runner hands it to the harness. */
export const runnerMessageOf = (
  message: OrchestrationV2ConversationMessage,
): RunnerMessageInput => ({
  messageId: message.id,
  text: message.text,
  attachments: message.attachments,
  createdBy: message.createdBy,
  creationSource: message.creationSource,
});

/**
 * The turn to hand the Runner: the live harness run, until the Runner reports
 * it started. The caller adds its trace id.
 */
export function runnerTurnFor(projection: Projection): Omit<RunnerTurn, "traceId"> | null {
  const run = harnessRun(projection);
  if (run === undefined || !awaitsHandoff(run)) return null;
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  if (
    message === undefined ||
    providerThread === undefined ||
    run.activeAttemptId === null ||
    run.rootNodeId === null
  ) {
    return null;
  }
  // The Runner knows harnesses, not pools: the pool travels in the model token.
  const instanceId = runnerInstanceFor(run.providerInstanceId) ?? run.providerInstanceId;
  // The harness counts turns on its own session; runs that never started never
  // reached it. A turn with no session to resume starts over at 1 instead
  // (`ThreadRunner`'s `turnFor`); later ones count from the thread's runs,
  // which only has to stay above 1 for the harness to resume.
  const priorTurns = projection.runs.filter(
    (candidate) =>
      candidate.ordinal < run.ordinal &&
      candidate.providerThreadId === providerThread.id &&
      candidate.startedAt !== null,
  ).length;
  return {
    threadId: projection.thread.id,
    runId: run.id,
    runOrdinal: run.ordinal,
    providerTurnOrdinal: priorTurns + 1,
    attemptId: run.activeAttemptId,
    rootNodeId: run.rootNodeId,
    appThread: projection.thread,
    providerThread: { ...providerThread, providerInstanceId: instanceId },
    message: runnerMessageOf(message),
    modelSelection: { ...run.modelSelection, instanceId },
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    ...(run.restartContinuationOfRunId === undefined
      ? {}
      : { restartContinuationOfRunId: run.restartContinuationOfRunId }),
  };
}

/** Ends a live run as failed, with the reason in the transcript. */
export function failRunEvents(
  projection: Projection,
  run: Run,
  failure: OrchestrationV2ProviderFailure,
  ctx: DecisionContext,
  providerTurnId: ProviderTurnId | null = null,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const errorItem: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`turn-item:${run.id}:failure`),
    threadId: projection.thread.id,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: itemOrdinal(run.ordinal, ERROR_ITEM_BAND_POSITION),
    status: "failed",
    title: failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
    startedAt: ctx.now,
    completedAt: ctx.now,
    updatedAt: ctx.now,
    type: "error",
    failure,
  };
  return finishRunEvents(projection, run, "failed", ctx, {
    leading: [turnItemEvent(ctx, errorItem)],
  });
}

export const unknownFailure = (message: string): OrchestrationV2ProviderFailure => ({
  class: "unknown",
  message,
  code: null,
  retryable: null,
});

/** `turn.started`: the harness loaded its session, so the run is running. */
function startedEvents(
  projection: Projection,
  run: Run,
  item: Extract<RunnerItem, { readonly kind: "turn.started" }>,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  if (!awaitsHandoff(run) && !(run.status === "waiting" && attempt?.status === "pending"))
    return [];
  const threadId = projection.thread.id;
  const current = providerThreadFor(projection, run, "active", ctx);
  // The harness's native state, under the thread's own identity for the record.
  const providerThread = {
    ...item.providerThread,
    id: current.id,
    driver: item.providerSession.driver,
    providerInstanceId: run.providerInstanceId,
    providerSessionId: item.providerSession.id,
    appThreadId: threadId,
    ownerNodeId: current.ownerNodeId,
    firstRunOrdinal: current.firstRunOrdinal,
    lastRunOrdinal: run.ordinal,
    handoffIds: current.handoffIds,
    forkedFrom: current.forkedFrom,
    status: "active" as const,
    createdAt: current.createdAt,
    updatedAt: ctx.now,
  };
  const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
  const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
  return [
    providerSessionEvent(ctx, threadId, item.providerSession),
    providerThreadEvent(ctx, threadId, providerThread),
    runEvent(ctx, "run.updated", {
      ...run,
      status: run.status === "waiting" ? "waiting" : "running",
      startedAt: ctx.now,
    }),
    ...(attempt === undefined
      ? []
      : [
          attemptEvent(ctx, threadId, "run-attempt.updated", {
            ...attempt,
            ...(nativeThreadId == null ? {} : { nativeThreadId }),
            status: "running",
            startedAt: ctx.now,
          }),
        ]),
    ...(node === undefined
      ? []
      : [nodeEvent(ctx, { ...node, status: "running", startedAt: ctx.now })]),
  ];
}

const TERMINAL_ENDINGS: Readonly<Record<string, RunEnding>> = {
  completed: "completed",
  interrupted: "interrupted",
  cancelled: "interrupted",
  failed: "failed",
};

/** `turn.terminal`: the harness finished the run's turn. Ignored once the run already ended. */
function terminalEvents(
  projection: Projection,
  event: Json,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const run = projection.runs.find((candidate) => candidate.ordinal === event.runOrdinal);
  const reported = stringField(event, "status");
  const status =
    reported !== undefined && Object.hasOwn(TERMINAL_ENDINGS, reported)
      ? TERMINAL_ENDINGS[reported]
      : undefined;
  if (run === undefined || status === undefined || run.id !== harnessRun(projection)?.id) {
    return [];
  }
  if (status !== "failed") return finishRunEvents(projection, run, status, ctx);
  const failure = decodeFailure(event.failure);
  return failRunEvents(
    projection,
    run,
    Exit.isSuccess(failure) ? failure.value : unknownFailure("The provider turn failed."),
    ctx,
    (stringField(event, "providerTurnId") as ProviderTurnId | undefined) ?? null,
  );
}

const decodeFailure = Schema.decodeUnknownExit(Schema.toCodecJson(OrchestrationV2ProviderFailure));

/** The events one reported item becomes. */
function itemEvents(
  projection: Projection,
  item: RunnerItem,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> | "undecodable" {
  if (item.kind === "workflow.stopped") return workflowStopResult(projection, item, ctx);
  const run = harnessRun(projection);
  // Usage and log lines are for the turn's diagnostics, not its events; a drain is the lease's.
  if (
    item.kind === "usage" ||
    item.kind === "log" ||
    item.kind === "machine.drained" ||
    item.kind === "git.pull.result" ||
    item.kind === "git.pull.interrupted"
  )
    return [];
  if (item.kind === "provider") {
    return stringField(item.event, "type") === "turn.terminal"
      ? terminalEvents(projection, item.event, ctx)
      : recordedEvents(projection, item, run?.id, ctx);
  }
  // A report about a run that already ended (stopped, or failed for want of a machine).
  if (run === undefined || run.id !== item.runId) return [];
  switch (item.kind) {
    case "turn.started":
      return startedEvents(projection, run, item, ctx);
    case "turn.failed":
      return failRunEvents(projection, run, unknownFailure(item.message), ctx);
    case "drive.checkpoint":
      return checkpointEvents(projection, run, item, ctx);
    case "drive.notice":
      return noticeEvents(projection, run, item, ctx);
    case "dependencies.progress":
      return dependencyProgressEvents(projection, run, item, ctx);
    // Why the Runner stopped the turn.
    case "session.notice":
      return systemNoticeEvents(
        projection,
        run,
        {
          id: TurnItemId.make(`turn-item:${run.id}:session`),
          title: "Session",
          message: item.message,
        },
        ctx,
      );
    // Which of the folder's secrets the turn runs without; the Runner names no value.
    case "secrets.notice":
      return systemNoticeEvents(
        projection,
        run,
        {
          id: TurnItemId.make(`turn-item:${run.id}:secrets`),
          title: "Secrets",
          message: item.message,
        },
        ctx,
      );
    // The lease decides what a move means (`ThreadRunner`'s batch).
    case "machine.outgrown":
      return [];
  }
}

/**
 * The pool moved `runId`'s thread off its account (`pool/threadAccounts.ts`):
 * a notice in that run's transcript, while it's the live one.
 */
export function accountMovedEvents(
  projection: Projection,
  runId: RunId,
  message: string,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const run = harnessRun(projection);
  if (run === undefined || run.id !== runId) return [];
  return systemNoticeEvents(
    projection,
    run,
    { id: TurnItemId.make(`turn-item:${run.id}:account`), title: "Account", message },
    ctx,
  );
}

/**
 * The harness's session as this machine can drive it: one whose Runner can't
 * take `steer` (#562) reads as a session that can't steer, so messages sent
 * mid-turn queue instead of waiting on a machine that never hands them over.
 */
const asDriven = (event: OrchestrationV2DomainEvent, steers: boolean) =>
  steers ||
  event.type !== "provider-session.updated" ||
  !event.payload.capabilities.turns.supportsActiveSteering
    ? event
    : {
        ...event,
        payload: {
          ...event.payload,
          capabilities: {
            ...event.payload.capabilities,
            turns: { ...event.payload.capabilities.turns, supportsActiveSteering: false },
          },
        },
      };

/**
 * A batch's events, each item decided against the projection the earlier ones
 * left, and the adapter event types it could not read. A `machine.outgrown`
 * for the live run ends the batch: the caller moves the run to a heavy
 * machine (`outgrown` is why), and nothing the light one said after that counts.
 * `steers`: whether the machine's Runner takes `steer`.
 */
export function runnerBatchEvents(
  projection: Projection,
  items: ReadonlyArray<RunnerItem>,
  ctx: DecisionContext,
  steers = false,
  pendingChildren: ReadonlyArray<NativeChildPending> = [],
  onCommandOutput?: (projection: Projection, item: ProviderRunnerItem) => void,
): {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly undecodable: ReadonlyArray<string>;
  readonly outgrown: string | null;
  /** Provider-native child history authenticated by this parent batch's subagent records. */
  readonly nativeChildren: ReadonlyArray<NativeChildBatch>;
  /** Child rows held until the parent projection attests their native lineage. */
  readonly pendingNativeChildren: ReadonlyArray<NativeChildPending>;
  /** Content-free reasons native child rows could not be saved. */
  readonly nativeChildDiagnostics: ReadonlyArray<NativeChildDiagnostic>;
  /** A `machine.drained` in the batch: which drain it answers, and what couldn't be saved. */
  readonly drained: { readonly id: number; readonly unsaved: ReadonlyArray<string> } | null;
} {
  const events: Array<OrchestrationV2DomainEvent> = [];
  const undecodable: Array<string> = [];
  const diagnosticCounts = new Map<string, NativeChildDiagnostic>();
  const newlyTerminalRunIds = new Set<RunId>();
  const diagnose = (runId: RunId, reason: NativeChildFailure) => {
    const key = `${runId}\n${reason}`;
    const known = diagnosticCounts.get(key);
    diagnosticCounts.set(key, { runId, reason, count: (known?.count ?? 0) + 1 });
  };
  let drained: { readonly id: number; readonly unsaved: ReadonlyArray<string> } | null = null;
  let current = projection;
  const nativeChildCandidates = new Map<string, NativeChildCandidate>();
  const keyOf = (parentRunId: RunId, childThreadId: ThreadId) => `${parentRunId}\n${childThreadId}`;
  const addDrivers = (candidate: NativeChildCandidate) => {
    for (const item of candidate.items) {
      const driver = stringField(item.event, "driver");
      if (driver !== undefined) candidate.drivers.add(driver);
    }
  };
  for (const pending of pendingChildren) {
    const candidate: NativeChildCandidate = {
      childThreadId: pending.childThreadId,
      parentRunId: pending.parentRunId,
      ...(pending.appThread === undefined ? {} : { appThread: pending.appThread }),
      ...(pending.createdByDriver === undefined
        ? {}
        : { createdByDriver: pending.createdByDriver }),
      creationDecode: pending.creationDecode === true,
      items: [...pending.items],
      drivers: new Set<string>(),
      invalidDriver: pending.invalidDriver,
      materialized: pending.materialized,
    };
    addDrivers(candidate);
    if (pending.createdByDriver !== undefined) candidate.drivers.add(pending.createdByDriver);
    nativeChildCandidates.set(keyOf(pending.parentRunId, pending.childThreadId), candidate);
  }
  const captureNativeChild = (item: RunnerItem) => {
    if (item.kind !== "provider") return;
    const appThread = appThreadCreated(item);
    const creationDecodeFailed =
      stringField(item.event, "type") === "app_thread.created" && appThread === undefined;
    const childThreadId =
      appThread?.id ??
      (creationDecodeFailed ? appThreadCreatedId(item) : undefined) ??
      (providerEventThreadId(item) as ThreadId | undefined);
    if (creationDecodeFailed) diagnose(item.runId, "creation_decode");
    if (childThreadId === undefined || childThreadId === projection.thread.id) return;
    const parentRunId = item.runId;
    const key = keyOf(parentRunId, childThreadId);
    const candidate: NativeChildCandidate = nativeChildCandidates.get(key) ?? {
      childThreadId,
      parentRunId,
      items: [],
      drivers: new Set<string>(),
      creationDecode: false,
      invalidDriver: false,
      materialized: false,
    };
    if (appThread !== undefined) {
      const driver = stringField(item.event, "driver");
      if (driver === undefined) candidate.invalidDriver = true;
      if (
        candidate.appThread !== undefined &&
        (candidate.appThread.id !== appThread.id || candidate.createdByDriver !== driver)
      ) {
        candidate.invalidDriver = true;
      }
      candidate.appThread ??= appThread;
      if (driver !== undefined) candidate.createdByDriver ??= driver;
    } else if (creationDecodeFailed) {
      candidate.creationDecode = true;
    } else {
      candidate.items.push(item as ProviderRunnerItem);
    }
    const driver = stringField(item.event, "driver");
    if (driver !== undefined) candidate.drivers.add(driver);
    else candidate.invalidDriver = true;
    nativeChildCandidates.set(key, candidate);
  };
  const pendingNativeChildrenNow = (): ReadonlyArray<NativeChildPending> =>
    [...nativeChildCandidates.values()].flatMap((candidate) => {
      const subagent = current.subagents.find(
        (item) =>
          item.childThreadId === candidate.childThreadId &&
          item.runId === candidate.parentRunId &&
          item.origin === "provider_native",
      );
      const attested =
        candidate.appThread !== undefined &&
        subagent !== undefined &&
        nativeChildMatches(projection, candidate, subagent);
      return [
        {
          parentRunId: candidate.parentRunId,
          childThreadId: candidate.childThreadId,
          ...(candidate.appThread === undefined ? {} : { appThread: candidate.appThread }),
          ...(candidate.createdByDriver === undefined
            ? {}
            : { createdByDriver: candidate.createdByDriver }),
          ...(candidate.creationDecode ? { creationDecode: true } : {}),
          invalidDriver: candidate.invalidDriver,
          materialized: attested ? true : candidate.materialized,
          items: attested ? [] : candidate.items,
        },
      ];
    });
  const nativeChildren = (): ReadonlyArray<NativeChildBatch> =>
    [...nativeChildCandidates.values()].flatMap((candidate) => {
      if (candidate.appThread === undefined) return [];
      const subagent = current.subagents.find(
        (item) =>
          item.childThreadId === candidate.childThreadId &&
          item.runId === candidate.parentRunId &&
          item.origin === "provider_native",
      );
      return (!candidate.materialized || candidate.items.length > 0) &&
        subagent !== undefined &&
        nativeChildMatches(projection, candidate, subagent)
        ? [
            {
              childThreadId: candidate.childThreadId,
              parentRunId: candidate.parentRunId,
              appThread: candidate.appThread,
              attestation: subagent,
              items: candidate.items,
            },
          ]
        : [];
    });
  for (const item of items) {
    if (item.kind === "machine.outgrown" && harnessRun(current)?.id === item.runId) {
      return {
        events,
        undecodable,
        nativeChildren: nativeChildren(),
        pendingNativeChildren: pendingNativeChildrenNow(),
        nativeChildDiagnostics: [...diagnosticCounts.values()],
        outgrown: item.reason,
        drained,
      };
    }
    if (item.kind === "provider" && item.event.type === "command_output.delta") {
      onCommandOutput?.(current, item);
      continue;
    }
    captureNativeChild(item);
    if (item.kind === "machine.drained") drained = { id: item.id, unsaved: item.unsaved };
    const next = itemEvents(current, item, ctx);
    if (next === "undecodable") {
      undecodable.push(item.kind === "provider" ? String(item.event.type) : item.kind);
      continue;
    }
    if (next.length === 0) continue;
    const driven = steers ? next : next.map((event) => asDriven(event, steers));
    events.push(...driven);
    const previouslyLiveRuns = new Set(current.runs.filter(isLiveRun).map((run) => run.id));
    for (const event of driven) {
      if (
        event.type === "run.updated" &&
        isTerminalRunStatus(event.payload.status) &&
        previouslyLiveRuns.has(event.payload.id)
      ) {
        newlyTerminalRunIds.add(event.payload.id);
      }
    }
    current = applyEvents(current, driven) ?? current;
  }
  for (const candidate of nativeChildCandidates.values()) {
    if (
      !newlyTerminalRunIds.has(candidate.parentRunId) ||
      (candidate.materialized && candidate.items.length === 0)
    ) {
      continue;
    }
    const subagent = current.subagents.find(
      (item) =>
        item.childThreadId === candidate.childThreadId &&
        item.runId === candidate.parentRunId &&
        item.origin === "provider_native",
    );
    const reason =
      subagent === undefined
        ? "missing_attestation"
        : nativeChildFailure(current, candidate, subagent);
    if (reason !== null && reason !== "creation_decode") {
      diagnose(candidate.parentRunId, reason);
    }
  }
  for (const subagent of current.subagents) {
    if (
      subagent.origin === "provider_native" &&
      subagent.runId !== null &&
      subagent.childThreadId !== null &&
      newlyTerminalRunIds.has(subagent.runId) &&
      !nativeChildCandidates.has(keyOf(subagent.runId, subagent.childThreadId))
    ) {
      diagnose(subagent.runId, "missing_creation");
    }
  }
  return {
    events,
    undecodable,
    nativeChildren: nativeChildren(),
    pendingNativeChildren: pendingNativeChildrenNow(),
    nativeChildDiagnostics: [...diagnosticCounts.values()],
    outgrown: null,
    drained,
  };
}
