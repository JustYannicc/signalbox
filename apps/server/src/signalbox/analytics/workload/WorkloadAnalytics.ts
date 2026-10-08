/**
 * Records the raw resource usage #116's cost replay prices against cloud
 * providers, to Signalbox's PostHog project only:
 *
 * - `workload.turn.completed`, per turn, from the committed orchestration
 *   events plus the resource monitor's process snapshots;
 * - `workload.project.sampled`, weekly, the on-disk size of each project
 *   used that week.
 *
 * Thread and project ids are hashed. Commands are reduced to a category on
 * this machine; no command text, path, or content is sent.
 *
 * @module WorkloadAnalytics
 */
import type { OrchestrationV2DomainEvent, OrchestrationV2Run } from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { hashWorkloadId, secondsSincePreviousTurn } from "@t3tools/shared/workloadUsage";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../../../atomicWrite.ts";
import * as ServerConfig from "../../../config.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStoreV2 from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import { isTerminalRunStatus } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as NativeTelemetryClient from "../../../resourceTelemetry/NativeTelemetryClient.ts";
import { forkParked } from "../../../serverActivation.ts";
import { SignalboxAnalytics } from "../ProductAnalytics.ts";
import { makeProcessAttribution, processKey } from "./processAttribution.ts";
import { lookupCwds } from "./processCwd.ts";
import { sampleProject } from "./projectSample.ts";
import { isWorkingRun, makeWorkloadTurns, type CompletedTurn } from "./workloadTurns.ts";

const TURN_EVENT = "workload.turn.completed";
const PROJECT_EVENT = "workload.project.sampled";

/** Fork-owned state file: when projects were last sampled. */
const WORKLOAD_STATE_FILE = "signalbox-workload-analytics.json";
const PROCESS_SAMPLE_INTERVAL = Duration.seconds(5);
const FINAL_SAMPLE_TIMEOUT = Duration.seconds(2);
const PROJECT_SAMPLE_INTERVAL = Duration.days(7);
const PROJECT_SAMPLE_CHECK = Duration.hours(6);
const PROJECT_SAMPLE_STARTUP_DELAY = Duration.minutes(10);

const WorkloadState = Schema.Struct({
  projectsSampledAt: Schema.optional(Schema.DateTimeUtcFromString),
});
const decodeState = Schema.decodeEffect(fromLenientJson(WorkloadState));
const encodeState = Schema.encodeEffect(fromJsonStringPretty(WorkloadState));

const hashId = hashWorkloadId;

const turnProperties = Effect.fn("WorkloadAnalytics.turnProperties")(function* (
  turn: CompletedTurn,
  secondsSincePreviousTurn: number | undefined,
) {
  // Undefined fields are left out when the batch is encoded as JSON.
  return {
    threadHash: yield* hashId(turn.threadId),
    projectHash: turn.projectId === undefined ? undefined : yield* hashId(turn.projectId),
    provider: turn.provider,
    model: turn.model,
    outcome: turn.outcome,
    durationSeconds: turn.durationSeconds,
    secondsSincePreviousTurn,
    concurrentTurnsAtStart: turn.concurrentTurnsAtStart,
    commandCounts: turn.commandCounts,
    commandSeconds: turn.commandSeconds,
    fileChangeBatches: turn.fileChangeBatches,
    processCpuSeconds: turn.process?.cpuSeconds,
    processPeakRssBytes: turn.process?.peakRssBytes,
    processSamples: turn.process?.samples,
  };
});

export const makeWorkloadAnalytics = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStoreV2.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const telemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const analytics = yield* SignalboxAnalytics;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  // Captured so the methods below need nothing from their caller.
  const context = yield* Effect.context<
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
  >();

  const scope = yield* Effect.scope;
  const turns = makeWorkloadTurns();

  const logSkipped = (message: string) => (cause: unknown) =>
    Effect.logDebug(`workload analytics: ${message}`, { cause });

  // cwd per process, read once: the harnesses and commands we attribute
  // don't change directory after they start.
  const attribution = makeProcessAttribution(process.pid);
  const cwds = new Map<string, string | null>();
  const onSnapshot = (snapshot: NativeTelemetryClient.NativeTelemetrySnapshot) =>
    Effect.gen(function* () {
      const processes = snapshot.snapshot.processes;
      // Between runs CPU belongs to no turn; a sample now would undo `reset`.
      if (turns.size() === 0) return;
      const unknown = attribution
        .needingCwd(processes)
        .filter((process) => !cwds.has(processKey(process)));
      const found = yield* lookupCwds(unknown.map((process) => process.pid)).pipe(
        Effect.provide(context),
      );
      for (const process of unknown) cwds.set(processKey(process), found.get(process.pid) ?? null);
      const present = new Set(processes.map(processKey));
      for (const key of cwds.keys()) if (!present.has(key)) cwds.delete(key);
      const usage = attribution.sample({
        sampledAtMs: snapshot.snapshot.sampledAtUnixMs,
        processes,
        turns: turns.attributionTurns(),
        cwdOf: (key) => cwds.get(key) ?? undefined,
      });
      turns.processSample(usage);
    }).pipe(Effect.catchCause(logSkipped("process sample skipped")));

  // On demand and only while a run is in flight: subscribing to the
  // monitor's live stream would pin it to its 1 s rate for good.
  const sampleLock = yield* Semaphore.make(1);
  const sampleProcesses = Effect.suspend(() =>
    turns.size() === 0 ? Effect.void : Effect.flatMap(telemetry.sampleNow, onSnapshot),
  ).pipe(
    sampleLock.withPermit,
    // Without the native resource monitor, turns carry no process usage.
    Effect.catchCause(logSkipped("process sample skipped")),
  );

  const startTurn = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      // Nothing would be sent: don't track, look up or sample anything.
      if (!(yield* analytics.active)) return;
      const shell = yield* orchestrator.getThreadShell(run.threadId);
      const project = shell === null ? Option.none() : yield* projects.get(shell.projectId);
      const configured =
        shell?.worktreePath ??
        Option.getOrUndefined(Option.map(project, (row) => row.workspaceRoot));
      // Process cwds come back resolved (`/tmp` is `/private/tmp` on macOS).
      const directory =
        configured === undefined
          ? undefined
          : yield* fs.realPath(configured).pipe(Effect.orElseSucceed(() => configured));
      turns.start({ run, projectId: shell?.projectId, directory });
      // The baseline sample runs beside the event stream, not in its way.
      yield* Effect.forkIn(sampleProcesses, scope);
    }).pipe(Effect.catchCause(logSkipped("turn start skipped")));

  const previousTurnEndedAt = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const { runs } = yield* projections.getThreadRecords(run.threadId, ["runs"]);
      const startedAt = run.startedAt === null ? Infinity : DateTime.toEpochMillis(run.startedAt);
      const ends = runs.flatMap((other) =>
        other.id !== run.id && other.completedAt !== null
          ? [DateTime.toEpochMillis(other.completedAt)]
          : [],
      );
      const before = ends.filter((end) => end <= startedAt);
      return before.length === 0 ? undefined : Math.max(...before);
    }).pipe(Effect.orElseSucceed(() => undefined));

  const finishTurn = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      if (!turns.isTracking(run.id)) return;
      // Bounded, so a slow monitor can't hold up the event stream.
      yield* sampleProcesses.pipe(Effect.timeoutOption(FINAL_SAMPLE_TIMEOUT));
      const completed = turns.finish(run);
      if (turns.size() === 0) attribution.reset();
      if (completed === undefined || run.startedAt === null) return;
      const previousEnd = yield* previousTurnEndedAt(run);
      const gap =
        previousEnd === undefined
          ? undefined
          : secondsSincePreviousTurn(previousEnd, DateTime.toEpochMillis(run.startedAt));
      const properties = yield* turnProperties(completed, gap).pipe(Effect.provide(context));
      yield* analytics.record(TURN_EVENT, properties);
    }).pipe(Effect.catchCause(logSkipped("turn record skipped")));

  const onEvent = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    if (event.runId !== undefined && event.driver !== undefined) {
      turns.noteProvider(event.runId, event.driver);
    }
    switch (event.type) {
      case "run.created":
      case "run.updated":
        if (isWorkingRun(event.payload) && !turns.has(event.payload.id)) {
          return startTurn(event.payload);
        }
        return isTerminalRunStatus(event.payload.status) ? finishTurn(event.payload) : Effect.void;
      case "turn-item.updated":
        turns.item(event.payload);
        return Effect.void;
      default:
        return Effect.void;
    }
  };

  const statePath = path.join(stateDir, WORKLOAD_STATE_FILE);
  const readState = fs.readFileString(statePath).pipe(
    Effect.flatMap(decodeState),
    Effect.orElseSucceed(() => ({}) as typeof WorkloadState.Type),
  );

  // Projects with a turn started in the last sampling interval.
  const recentProjectRoots = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const since = DateTime.toEpochMillis(now) - Duration.toMillis(PROJECT_SAMPLE_INTERVAL);
    const snapshot = yield* orchestrator.getShellSnapshot({ location: "active" });
    const projectIds = new Set(
      snapshot.threads.flatMap((thread) =>
        thread.latestRunStartedAt != null &&
        DateTime.toEpochMillis(thread.latestRunStartedAt) >= since
          ? [thread.projectId]
          : [],
      ),
    );
    const rows = yield* projects.list({ projectIds: [...projectIds] });
    return rows.map((row) => ({ projectId: row.projectId, root: row.workspaceRoot }));
  });

  const sampleProjectsIfDue = Effect.gen(function* () {
    if (!(yield* analytics.active)) return;
    const state = yield* readState;
    const now = yield* DateTime.now;
    if (
      state.projectsSampledAt !== undefined &&
      DateTime.isLessThan(
        now,
        DateTime.addDuration(state.projectsSampledAt, PROJECT_SAMPLE_INTERVAL),
      )
    ) {
      return;
    }

    // Nothing used yet: check again later rather than wait a week.
    const roots = yield* recentProjectRoots;
    if (roots.length === 0) return;
    for (const { projectId, root } of roots) {
      const sample = yield* sampleProject(root).pipe(Effect.provide(context));
      yield* analytics.record(PROJECT_EVENT, {
        projectHash: yield* hashId(projectId).pipe(Effect.provide(context)),
        ...sample,
      });
    }
    const contents = yield* encodeState({ ...state, projectsSampledAt: now });
    yield* writeFileStringAtomically({ filePath: statePath, contents: `${contents}\n` }).pipe(
      Effect.provide(context),
    );
  }).pipe(Effect.catchCause(logSkipped("project sample skipped")));

  return {
    onEvent,
    onSnapshot,
    sampleProjectsIfDue,
    start: Effect.gen(function* () {
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, onEvent).pipe(
          Effect.catchCause(logSkipped("event stream stopped")),
        ),
      );
      yield* forkParked(
        Effect.sleep(PROCESS_SAMPLE_INTERVAL).pipe(Effect.andThen(sampleProcesses), Effect.forever),
      );
      yield* forkParked(
        Effect.sleep(PROJECT_SAMPLE_STARTUP_DELAY).pipe(
          Effect.andThen(
            sampleProjectsIfDue.pipe(
              Effect.andThen(Effect.sleep(PROJECT_SAMPLE_CHECK)),
              Effect.forever,
            ),
          ),
        ),
      );
    }),
  };
});

/** Starts workload analytics with the server; hooked into `server.ts`. */
export const layer = Layer.effectDiscard(
  Effect.flatMap(makeWorkloadAnalytics, (service) => service.start),
).pipe(Layer.provide(ProjectionStoreV2.layer), Layer.provide(ProcessRunner.layer));
