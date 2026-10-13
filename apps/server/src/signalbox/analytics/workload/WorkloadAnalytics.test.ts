import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ResourceMonitorProcessSample,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../../config.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStoreV2 from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as NativeTelemetryClient from "../../../resourceTelemetry/NativeTelemetryClient.ts";
import { SignalboxAnalytics } from "../ProductAnalytics.ts";
import * as WorkloadAnalytics from "./WorkloadAnalytics.ts";

interface Recorded {
  readonly event: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = (iso: string) => DateTime.makeUnsafe(iso);
const PROJECT = ProjectId.make("project-1");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };

const run = (input: {
  readonly id: string;
  readonly threadId: string;
  readonly status: OrchestrationV2Run["status"];
  readonly startedAt: string | null;
  readonly completedAt?: string;
}): OrchestrationV2Run => ({
  id: RunId.make(input.id),
  threadId: ThreadId.make(input.threadId),
  ordinal: 1,
  providerInstanceId: MODEL.instanceId,
  modelSelection: MODEL,
  providerThreadId: null,
  userMessageId: MessageId.make(`message-${input.id}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: input.status,
  requestedAt: at(input.startedAt ?? "2026-10-06T09:00:00Z"),
  startedAt: input.startedAt === null ? null : at(input.startedAt),
  completedAt: input.completedAt === undefined ? null : at(input.completedAt),
  checkpointId: null,
  contextHandoffId: null,
});

const runEvent = (payload: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event-${payload.id}-${payload.status}`),
  threadId: payload.threadId,
  runId: payload.id,
  occurredAt: payload.completedAt ?? payload.requestedAt,
  type: "run.updated",
  payload,
});

const itemBase = (id: string, runId: string, status: OrchestrationV2TurnItem["status"]) => ({
  id: TurnItemId.make(id),
  threadId: ThreadId.make("thread-a"),
  runId: RunId.make(runId),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status,
  title: null,
  updatedAt: at("2026-10-06T10:02:00Z"),
});

const itemEvent = (item: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event-${item.id}-${item.status}`),
  threadId: item.threadId,
  runId: item.runId ?? undefined,
  driver: ProviderDriverKind.make("codex"),
  occurredAt: item.updatedAt,
  type: "turn-item.updated",
  payload: item,
});

const command = (
  id: string,
  input: string,
  status: OrchestrationV2TurnItem["status"],
  seconds: number,
): OrchestrationV2TurnItem => ({
  ...itemBase(id, "run-a1", status),
  type: "command_execution",
  input,
  startedAt: at("2026-10-06T10:02:00Z"),
  completedAt: DateTime.add(at("2026-10-06T10:02:00Z"), { seconds }),
});

const fileChange = (id: string, status: OrchestrationV2TurnItem["status"]) =>
  ({
    ...itemBase(id, "run-a1", status),
    type: "file_change",
    fileName: "secret-plan.md",
    startedAt: null,
    completedAt: null,
  }) satisfies OrchestrationV2TurnItem;

const sample = (
  pid: number,
  cpuTimeMs: number,
  residentBytes: number,
): ResourceMonitorProcessSample => ({
  pid,
  ppid: process.pid,
  // After every run in these tests was requested: the harness is theirs.
  startTimeMs: Date.parse("2026-10-06T10:01:45Z"),
  runTimeMs: 0,
  name: "sleep",
  command: "sleep 30",
  status: "run",
  cpuPercent: 0,
  cpuTimeMs,
  residentBytes,
  virtualBytes: 0,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  ioSemantics: "storage",
});

const snapshot = (
  sequence: number,
  processes: ReadonlyArray<ResourceMonitorProcessSample>,
): NativeTelemetryClient.NativeTelemetrySnapshot => ({
  generation: 1,
  snapshot: {
    version: 3,
    type: "snapshot",
    sequence,
    sampledAtUnixMs: sequence * 1_000,
    collectionDurationMicros: 0,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes,
  },
});

const layerWorkload = (input: {
  readonly recorded: Array<Recorded>;
  readonly baseDir: string;
  readonly directories: Readonly<Record<string, string>>;
  readonly active?: boolean;
  readonly projectRoot?: string;
}) =>
  Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.empty,
      getThreadShell: (threadId) =>
        Effect.succeed({
          projectId: PROJECT,
          worktreePath: input.directories[threadId] ?? null,
        } as unknown as OrchestrationV2ThreadShell),
      getShellSnapshot: () =>
        Effect.map(DateTime.now, (now) => ({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [
            {
              projectId: PROJECT,
              latestRunStartedAt: now,
            } as unknown as OrchestrationV2ThreadShell,
          ],
          archivedThreads: [],
        })),
    }),
    Layer.mock(ProjectionStoreV2.ProjectionStoreV2)({
      getThreadRecords: () =>
        Effect.succeed({
          runs: [
            run({
              id: "run-a0",
              threadId: "thread-a",
              status: "completed",
              startedAt: "2026-10-06T09:59:00Z",
              completedAt: "2026-10-06T10:00:00Z",
            }),
            run({
              id: "run-a1",
              threadId: "thread-a",
              status: "completed",
              startedAt: "2026-10-06T10:01:30Z",
              completedAt: "2026-10-06T10:03:00Z",
            }),
          ],
        }) as never,
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () => Effect.succeedNone,
      list: () =>
        Effect.succeed(
          input.projectRoot === undefined
            ? []
            : [{ projectId: PROJECT, workspaceRoot: input.projectRoot } as never],
        ),
    }),
    Layer.mock(NativeTelemetryClient.NativeTelemetryClient)({}),
    Layer.succeed(
      SignalboxAnalytics,
      SignalboxAnalytics.of({
        record: (event, properties) =>
          Effect.sync(() => {
            input.recorded.push({ event, properties: properties ?? {} });
          }),
        active: Effect.succeed(input.active ?? true),
      }),
    ),
    ServerConfig.layerTest(process.cwd(), input.baseDir),
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  );

/** A real process working in `cwd`, so the cwd lookup has something to read. */
const spawnIn = (cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make("sleep", ["30"], { cwd }));
    return handle.pid;
  });

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  // lsof and /proc report the resolved path (macOS temp dirs are symlinked).
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "signalbox-workload-" }));
});

it.layer(NodeServices.layer)("WorkloadAnalytics", (it) => {
  it.effect("records one anonymous turn with commands, files, gap, concurrency and processes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recorded: Array<Recorded> = [];
        const fs = yield* FileSystem.FileSystem;
        // Unresolved on purpose: macOS temp dirs sit behind a symlink.
        const worktree = yield* fs.makeTempDirectoryScoped({ prefix: "signalbox-workload-" });
        const pid = yield* spawnIn(worktree);
        const workload = yield* WorkloadAnalytics.makeWorkloadAnalytics.pipe(
          Effect.provide(
            layerWorkload({
              recorded,
              baseDir: yield* tempDir,
              directories: { "thread-a": worktree, "thread-b": "/elsewhere" },
            }),
          ),
        );

        // Another thread's turn is already running.
        yield* workload.onEvent(
          runEvent(
            run({
              id: "run-b1",
              threadId: "thread-b",
              status: "running",
              startedAt: "2026-10-06T10:01:00Z",
            }),
          ),
        );
        const a1 = { id: "run-a1", threadId: "thread-a", startedAt: "2026-10-06T10:01:30Z" };
        yield* workload.onEvent(runEvent(run({ ...a1, status: "running" })));
        for (const item of [
          command("c1", "vp i", "running", 0),
          command("c1", "vp i", "completed", 20),
          command("c1", "vp i", "completed", 20),
          command("c2", "/bin/zsh -lc 'git status --short'", "failed", 1),
          fileChange("f1", "completed"),
          fileChange("f1", "completed"),
          fileChange("f2", "failed"),
        ]) {
          yield* workload.onEvent(itemEvent(item));
        }
        yield* workload.onSnapshot(snapshot(1, [sample(pid, 1_000, 5_000)]));
        yield* workload.onSnapshot(snapshot(2, [sample(pid, 3_500, 9_000)]));
        yield* workload.onSnapshot(snapshot(3, [sample(pid, 4_000, 7_000)]));

        const finished = run({ ...a1, status: "completed", completedAt: "2026-10-06T10:03:00Z" });
        yield* workload.onEvent(runEvent(finished));
        yield* workload.onEvent(runEvent(finished));

        assert.strictEqual(recorded.length, 1);
        const [turn] = recorded;
        assert.strictEqual(turn?.event, "workload.turn.completed");
        const properties = turn?.properties ?? {};
        assert.match(String(properties.threadHash), /^[0-9a-f]{16}$/);
        assert.deepInclude(properties, {
          provider: "codex",
          model: "gpt-6-astra",
          outcome: "completed",
          durationSeconds: 90,
          secondsSincePreviousTurn: 90,
          concurrentTurnsAtStart: 2,
          fileChangeBatches: 1,
          // Two samples after the first, 3 s of CPU between them; peak RSS 9 KB.
          processCpuSeconds: 3,
          processPeakRssBytes: 9_000,
          processSamples: 3,
        });
        assert.deepInclude(properties.commandCounts as object, { install: 1, git: 1, test: 0 });
        assert.deepInclude(properties.commandSeconds as object, { install: 20, git: 1 });

        const sent = encodeJson(recorded);
        for (const leaked of [
          "thread-a",
          "project-1",
          "vp i",
          "git status",
          "secret-plan",
          worktree,
        ]) {
          assert.notInclude(sent, leaked);
        }

        // The next turn in the thread measures its gap from the one before.
        const a2 = { id: "run-a2", threadId: "thread-a", startedAt: "2026-10-06T10:05:00Z" };
        yield* workload.onEvent(runEvent(run({ ...a2, status: "running" })));
        yield* workload.onEvent(
          runEvent(run({ ...a2, status: "failed", completedAt: "2026-10-06T10:05:10Z" })),
        );
        assert.deepInclude(recorded[1]?.properties ?? {}, {
          outcome: "error",
          secondsSincePreviousTurn: 120,
          concurrentTurnsAtStart: 2,
        });
      }),
    ),
  );

  it.effect("leaves out process usage it cannot pin to one thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recorded: Array<Recorded> = [];
        const checkout = yield* tempDir;
        const pid = yield* spawnIn(checkout);
        const workload = yield* WorkloadAnalytics.makeWorkloadAnalytics.pipe(
          Effect.provide(
            layerWorkload({
              recorded,
              baseDir: yield* tempDir,
              directories: { "thread-a": checkout, "thread-b": checkout },
            }),
          ),
        );
        const a = { id: "run-a1", threadId: "thread-a", startedAt: "2026-10-06T10:01:30Z" };
        yield* workload.onEvent(runEvent(run({ ...a, status: "running" })));
        yield* workload.onEvent(
          runEvent(
            run({
              id: "run-b1",
              threadId: "thread-b",
              status: "running",
              startedAt: "2026-10-06T10:01:40Z",
            }),
          ),
        );
        yield* workload.onSnapshot(snapshot(1, [sample(pid, 1_000, 5_000)]));
        yield* workload.onSnapshot(snapshot(2, [sample(pid, 2_000, 5_000)]));
        yield* workload.onEvent(
          runEvent(run({ ...a, status: "interrupted", completedAt: "2026-10-06T10:02:00Z" })),
        );

        const properties = recorded[0]?.properties ?? {};
        assert.strictEqual(properties.outcome, "interrupted");
        assert.isUndefined(properties.processCpuSeconds);
        assert.isUndefined(properties.processPeakRssBytes);
      }),
    ),
  );

  it.effect("samples recently used projects once a week, and not when inactive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* tempDir;
        const write = (file: string, bytes: number) =>
          fs
            .makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
            .pipe(Effect.andThen(fs.writeFile(path.join(root, file), new Uint8Array(bytes))));
        yield* write(".git/objects/pack/pack-1.pack", 64 * 1024);
        yield* write("node_modules/dep/index.js", 256 * 1024);
        yield* write("packages/a/node_modules/dep/index.js", 128 * 1024);
        yield* write("src/index.ts", 32 * 1024);
        yield* write("pnpm-lock.yaml", 1);

        const baseDir = yield* tempDir;
        const inactive: Array<Recorded> = [];
        yield* Effect.flatMap(
          WorkloadAnalytics.makeWorkloadAnalytics,
          (workload) => workload.sampleProjectsIfDue,
        ).pipe(
          Effect.provide(
            layerWorkload({
              recorded: inactive,
              baseDir,
              directories: {},
              active: false,
              projectRoot: root,
            }),
          ),
        );
        assert.strictEqual(inactive.length, 0);

        const recorded: Array<Recorded> = [];
        const workload = yield* WorkloadAnalytics.makeWorkloadAnalytics.pipe(
          Effect.provide(layerWorkload({ recorded, baseDir, directories: {}, projectRoot: root })),
        );
        yield* workload.sampleProjectsIfDue;
        yield* workload.sampleProjectsIfDue;

        assert.strictEqual(recorded.length, 1);
        const properties = recorded[0]?.properties ?? {};
        assert.strictEqual(recorded[0]?.event, "workload.project.sampled");
        assert.match(String(properties.projectHash), /^[0-9a-f]{16}$/);
        assert.deepEqual(properties.lockfiles, ["pnpm"]);
        const kib = (value: unknown) => Number(value) / 1024;
        assert.isAtLeast(kib(properties.gitBytes), 64);
        assert.isAtLeast(kib(properties.dependencyCacheBytes), 384);
        assert.isAtLeast(kib(properties.workingTreeBytes), 32);
        assert.isBelow(kib(properties.workingTreeBytes), 384);
        assert.notInclude(encodeJson(recorded), root);
      }),
    ),
  );
});
