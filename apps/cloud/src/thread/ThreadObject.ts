import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { PREVIEW_TUNNEL_PATH } from "@signalbox/runner-protocol/PreviewTunnel";
import { statusLineJson } from "@signalbox/runner-protocol/StatusLineProtocol";
import {
  type ModelGatewayProvider,
  RUNNER_HEARTBEAT_PING,
  RUNNER_HEARTBEAT_PONG,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { DurableObject } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { SqlError } from "effect/sql/SqlError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { canWrite, myDriveId } from "../drive/driveAccess.ts";
import type { ModelGatewayRecord } from "../models/ModelRecords.ts";
import {
  type DriveObjectNamespace,
  layerDurableObjects as layerDriveDirectory,
} from "../drive/DriveDirectory.ts";
import { type AttachmentObjects, attachmentStorage } from "../attachments/attachmentObjects.ts";
import {
  isRunnerAttachmentsPath,
  serveRunnerAttachments,
} from "../attachments/runnerAttachments.ts";
import * as GitHub from "../github/GitHub.ts";
import type { PackBucket } from "../drive/DrivePacks.ts";
import * as Evlog from "../observability/Evlog.ts";
import * as Platform from "../platform.ts";
import * as CloudflareSearchIndex from "../search/CloudflareSearchIndex.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as PreviewState from "./PreviewState.ts";
import * as BrowserTrail from "./preview/BrowserTrail.ts";
import { PreviewGateway } from "./preview/PreviewGateway.ts";
import { type PreviewEnv, previewSettings } from "./preview/previewHost.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import * as CloudAnalytics from "./diagnostics/CloudAnalytics.ts";
import * as DiagnosticsStore from "./diagnostics/DiagnosticsStore.ts";
import * as TurnDiagnostics from "./diagnostics/TurnDiagnostics.ts";
import * as TurnReports from "./diagnostics/TurnReports.ts";
import { layerFromEnv as layerMachineBackend, machineSettings } from "./runner/machineBackends.ts";
import * as BoatRecoveryControl from "./RecoveryDrillBoat.ts";
import * as MachineBackend from "./runner/MachineBackend.ts";
import {
  acceptRunnerSocket,
  endRunners,
  isRunnerSocket,
  onRunnerClose,
  onRunnerMessage,
  pushRunnerWork,
  type RunnerSocketHost,
} from "./runner/runnerSockets.ts";
import * as ThreadRunner from "./runner/ThreadRunner.ts";
import type { NativeChildBatchInput, NativeChildBatchResult } from "./runner/nativeChildBatch.ts";
import * as SessionRows from "./session/SessionRows.ts";
import { handleSessionRequest, isSessionApiPath } from "./session/sessionRoutes.ts";
import { deliverPendingEvents } from "./eventOutbox.ts";
import { deliverPendingSummary } from "./summaryOutbox.ts";
import { deliverPendingSearch } from "./searchOutbox.ts";
import { THREAD_OBJECT_JURISDICTION, type ThreadObjectApi } from "./ThreadDirectory.ts";
import * as ThreadBrowsing from "./browsing/ThreadBrowsing.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadSecretRequests from "./secrets/ThreadSecretRequests.ts";
import * as RunnerLiveness from "./RunnerLiveness.ts";
import { makeThreadObjectApi } from "./threadObjectApi.ts";
import { type BrowserReply, wire } from "./threadWire.ts";
import * as ThreadStore from "./ThreadStore.ts";
import * as ThreadPulls from "./ThreadPulls.ts";
import * as PullState from "./PullState.ts";
import * as TurnModels from "./TurnModels.ts";
import { scriptedProviderEnabled } from "./scriptedProvider.ts";
import { noteView } from "./statusLine/statusNotePolicy.ts";
import * as PullRequestSync from "./pullRequests/PullRequestSync.ts";
import * as StatusNoteModel from "./statusLine/StatusNoteModel.ts";
import * as ThreadStatusNotes from "./statusLine/ThreadStatusNotes.ts";
import { makeRecoveryDrill } from "./RecoveryDrill.ts";
import type { RecoveryDrillEnv, RecoveryDrillState } from "./RecoveryDrillProtocol.ts";
import { withRecoveryInspection } from "./RecoveryEvidence.ts";

/**
 * One per thread, named by its thread id, always in the EU jurisdiction. It
 * owns the thread's event log and receipts (see `ThreadEngine`). Scripted
 * turns run here; Claude and Codex turns run on a machine whose Runner dials
 * in over a WebSocket (see `runner/`).
 *
 * Work after a commit runs from the object's alarm: one scripted step per
 * firing, the summary outbox, the event outbox to the owner's automations
 * (`eventOutbox.ts`), the machine lease, then its linked pull requests' sync
 * (`pullRequests/PullRequestSync.ts`). Alarms are durable and retried, and
 * the object re-arms one whenever it wakes with work outstanding, so neither
 * an eviction nor a deploy strands a turn, a sidebar update, an automation's
 * event or a machine.
 *
 * It is also the PreviewGateway's brain (`preview/PreviewGateway.ts`): the
 * Runner's tunnel lands here, and so does every request to the thread's
 * preview origins. The agent's browser rides that tunnel too
 * (`preview/BrowserMirror.ts`); its trail is `preview/BrowserTrail.ts`.
 */

export interface ThreadObjectEnv
  extends
    MachineBackend.MachineBackendEnv,
    CloudflareSearchIndex.SearchIndexEnv,
    CloudAnalytics.CloudAnalyticsEnv,
    PreviewEnv,
    RecoveryDrillEnv,
    GitHub.GitHubEnv {
  /** Set by `vp run dev` only. Local workerd has no jurisdictions. */
  readonly LOCAL_WORKERD?: string;
  readonly USERS: UserDirectory.UserObjectNamespace;
  readonly THREADS: ThreadDirectory.ThreadObjectNamespace;
  /** Pools' objects: a turn starts only on a model its pool serves (`TurnModels.ts`). */
  readonly POOLS: PoolDirectory.PoolObjectNamespace;
  /** `1` in dev and tests: scripted turns run (`scriptedProvider.ts`). */
  readonly SCRIPTED_PROVIDER?: string;
  /** Drives' objects and packs (`drive/`). Turns work in a drive only when both are bound. */
  readonly DRIVES?: DriveObjectNamespace;
  /** Also where the thread's attachments live (`attachments/`), under `DRIVE_PACKS_PREFIX`. */
  readonly DRIVE_PACKS?: PackBucket & AttachmentObjects;
  readonly DRIVE_PACKS_PREFIX?: string;
}

/** Time between streamed chunks of a scripted reply. */
const STEP_INTERVAL_MS = 120;
/** Wait after the `failures`th failure in a row: 5 s, doubling, at most 5 min. */
const retryDelay = (failures: number) => Math.min(5_000 * 2 ** (failures - 1), 300_000);

type MachineReport = Omit<ThreadRunner.MachineReport, "generation" | "runId">;

/**
 * Records into the turn's diagnostics under the thread's lock, so it never
 * races a Runner batch's writes. A thread not created yet has nothing to record into.
 */
const recordUnderLock = (
  record: (diagnostics: TurnDiagnostics.TurnDiagnostics["Service"]) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const diagnostics = yield* TurnDiagnostics.TurnDiagnostics;
    yield* (yield* ThreadEngine.ThreadEngine).apply((projection) =>
      Effect.as(projection === null ? Effect.void : record(diagnostics), {
        events: [],
        result: undefined,
      }),
    );
  });

/** Logs a backend answer, against the lease's generation unless the caller names one. */
const noteMachine = (
  input: MachineReport & {
    readonly generation?: number | undefined;
    readonly runId: ThreadRunner.MachinePlan["runId"];
  },
) => ThreadRunner.ThreadRunner.use((runner) => runner.machineReported(input));

/** Drives, when bound, and the owner's access to one and commit author, asked of their own object. */
const layerThreadDrives = (env: ThreadObjectEnv) =>
  Layer.effect(
    ThreadRunner.ThreadDrives,
    Effect.map(UserDirectory.UserDirectory, (users) => ({
      enabled: env.DRIVES !== undefined && env.DRIVE_PACKS !== undefined,
      writes: (userId: string, driveId: string) =>
        // One's own Personal My Drive needs no lookup: Personal never goes away.
        driveId === myDriveId(PERSONAL_CONTEXT_ID, userId)
          ? Effect.succeed(true)
          : Effect.map(users.forUser(userId).driveAccess(driveId), canWrite),
      commitAuthor: (userId: string) => users.forUser(userId).githubCommitAuthor(),
    })),
  );

/** The owner's 1Password token for their turns' secrets, asked of their own object. */
const layerThreadSecrets = Layer.effect(
  ThreadRunner.ThreadSecrets,
  Effect.map(UserDirectory.UserDirectory, (users) => ({
    token: (userId: string) => users.forUser(userId).onePasswordToken(),
  })),
);

const layerNativeChildRelay = (parentThreadId: () => ThreadId) =>
  Layer.effect(
    ThreadRunner.NativeChildRelay,
    Effect.gen(function* () {
      const users = yield* UserDirectory.UserDirectory;
      const threads = yield* ThreadDirectory.ThreadDirectory;
      return {
        save: (input: NativeChildBatchInput) => {
          if (input.parentThreadId !== parentThreadId()) {
            return Effect.die("A native child relay was sent to the wrong parent thread.");
          }
          return Effect.flatMap(
            Effect.orDie(threads.forThread(input.childThreadId).recordNativeChildBatch(input)),
            (result): Effect.Effect<NativeChildBatchResult> =>
              result._tag === "child_mismatch"
                ? Effect.succeed(result)
                : Effect.as(
                    Effect.orDie(
                      users.forUser(input.owner.userId).copyThreadHome({
                        parentThreadId: input.parentThreadId,
                        childThreadId: input.childThreadId,
                        projectId: input.appThread.projectId,
                        ownerId: input.owner.contextId,
                      }),
                    ),
                    result,
                  ),
          );
        },
      };
    }),
  );

// The whole storage, not just `storage.sql`: commits and migrations run in transactions.
// `machine`: the object's own container, the light class's machine where the deployment has one.
const makeRuntime = (
  { storage, waitUntil }: Pick<DurableObjectState, "storage" | "waitUntil">,
  env: ThreadObjectEnv,
  previews: PreviewGateway,
  machine: MachineBackend.MachineHost,
  threadId: () => ThreadId,
  secretChanged: () => Promise<void>,
) => {
  const settings = machineSettings(env);
  const runner = ThreadRunner.layer.pipe(
    Layer.provide(
      Layer.succeed(ThreadRunner.PreviewHold, {
        held: Effect.sync(() => previews.held),
        lastActiveAt: Effect.sync(() => previews.lastActiveAt),
      }),
    ),
    Layer.provideMerge(layerNativeChildRelay(threadId)),
    Layer.provideMerge(Layer.mergeAll(layerThreadDrives(env), layerThreadSecrets)),
    Layer.provideMerge(ThreadPulls.layerReports.pipe(Layer.provideMerge(ThreadPulls.layer))),
    Layer.provideMerge(
      env.DRIVES === undefined
        ? Layer.empty
        : layerDriveDirectory(env.DRIVES, { localWorkerd: env.LOCAL_WORKERD === "1" }),
    ),
    // Its linked pull requests' sync reads GitHub only through the API, with the owner's token.
    Layer.provideMerge(
      PullRequestSync.layer.pipe(Layer.provide(GitHub.layer(null, GitHub.gitHubEndpoints(env)))),
    ),
    // The thread's browser tabs (#585), beside its conversation.
    Layer.provideMerge(ThreadBrowsing.layer),
    // Its status note (#670), written by the runtime through the owner's pool when the agent didn't.
    Layer.provideMerge(
      ThreadStatusNotes.layer.pipe(
        Layer.provide(
          StatusNoteModel.layerPools(env.POOLS, { localWorkerd: env.LOCAL_WORKERD === "1" }),
        ),
      ),
    ),
    Layer.provideMerge(
      ThreadSecretRequests.layer.pipe(
        Layer.provide(
          Layer.succeed(ThreadSecretRequests.SecretRequestChanged, Effect.promise(secretChanged)),
        ),
      ),
    ),
    Layer.provideMerge(ThreadEngine.layer),
    Layer.provideMerge(CloudflareSearchIndex.layerFromEnv(env)),
    Layer.provideMerge(
      TurnModels.layer({ scripted: scriptedProviderEnabled(env) }).pipe(
        Layer.provide(
          PoolDirectory.layerDurableObjects(env.POOLS, {
            localWorkerd: env.LOCAL_WORKERD === "1",
          }),
        ),
      ),
    ),
  );
  return ManagedRuntime.make(
    runner.pipe(
      Layer.provideMerge(Layer.mergeAll(TurnDiagnostics.layer, TurnReports.layer)),
      Layer.provideMerge(CloudAnalytics.layerFromEnv(env)),
      Layer.provideMerge(layerMachineBackend(env, machine)),
      Layer.provideMerge(BoatRecoveryControl.layer(settings?.kind === "boat" ? settings : null)),
      Layer.provideMerge(DiagnosticsStore.layer),
      Layer.provideMerge(ThreadStore.layerMachineRecords),
      Layer.provideMerge(
        Layer.mergeAll(
          ThreadStore.layer,
          PullState.layer,
          SessionRows.layer,
          PreviewState.layer,
          BrowserTrail.layer(attachmentStorage(env), threadId),
        ),
      ),
      Layer.provideMerge(
        UserDirectory.layerDurableObjects(env.USERS, { localWorkerd: env.LOCAL_WORKERD === "1" }),
      ),
      Layer.provideMerge(
        ThreadDirectory.layerDurableObjects(env.THREADS, {
          localWorkerd: env.LOCAL_WORKERD === "1",
        }),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          SqliteClient.layer({ storage }),
          Platform.layerCrypto,
          FetchHttpClient.layer,
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(Evlog.layer, Evlog.layerWaitUntil({ waitUntil }))),
    ),
  );
};

export class ThreadObject extends DurableObject<ThreadObjectEnv> implements ThreadObjectApi {
  private readonly runtime: ReturnType<typeof makeRuntime>;
  private readonly api: ReturnType<typeof makeThreadObjectApi>;
  private readonly runnerHost: RunnerSocketHost;
  private readonly gateway: PreviewGateway;
  private readonly recovery: ReturnType<typeof makeRecoveryDrill>;

  constructor(ctx: DurableObjectState, env: ThreadObjectEnv) {
    super(ctx, env);
    // Created only through `jurisdiction("eu")`; anything else is a routing bug.
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== THREAD_OBJECT_JURISDICTION) {
      throw new Error("Thread objects must live in the EU jurisdiction.");
    }
    this.gateway = new PreviewGateway({
      ctx,
      settings: previewSettings(env),
      threadId: () => this.threadId(),
      appOrigin: env.CLOUD_URL ?? "http://localhost:8787",
      configuration: () =>
        this.runtime.runPromise(PreviewState.PreviewState.use((state) => state.configuration)),
      saveServices: (services) =>
        this.runtime.runPromise(
          PreviewState.PreviewState.use((state) => state.saveServices(services)),
        ),
      drive: () =>
        this.runtime.runPromise(ThreadRunner.ThreadRunner.use((runner) => runner.previewDrive)),
      leaseToken: (generation, token) =>
        this.runtime.runPromise(
          ThreadRunner.ThreadRunner.use((runner) => runner.leaseToken(generation, token)),
        ),
      canSee: (userId) => this.canSee(userId),
      holdChanged: () => this.armAlarm(),
      browsed: () =>
        this.runtime.runPromise(BrowserTrail.BrowserTrail.use((trail) => trail.browsed)),
      storeStep: (step, recording) =>
        this.runtime.runPromise(
          BrowserTrail.BrowserTrail.use((trail) => trail.store(step, recording)),
        ),
      logError: (message, cause) =>
        void this.runtime.runPromise(Effect.logError(message, cause)).catch(() => undefined),
    });
    this.runtime = makeRuntime(
      { storage: ctx.storage, waitUntil: (promise) => ctx.waitUntil(promise) },
      env,
      this.gateway,
      {
        container: ctx.container,
        onExit: (exit, generation) =>
          void this.machineExited(exit, generation).catch((cause: unknown) =>
            this.runtime.runPromise(Effect.logError("machine exit failed", String(cause))),
          ),
      },
      () => this.threadId(),
      () => this.armAlarm(),
    );
    this.runnerHost = {
      ctx,
      now: () => this.now(),
      run: (effect) => this.runtime.runPromise(effect),
      holdsTurn: () =>
        this.runtime.runPromise(PullRequestSync.PullRequestSync.use((sync) => sync.holdsTurn)),
      afterChange: (work) => this.armAlarm(work),
    };
    this.api = makeThreadObjectApi(
      (effect) => this.runtime.runPromise(effect),
      async () => this.armAlarm(await pushRunnerWork(this.runnerHost)),
      (at) => this.setAlarmNoLaterThan(at),
    );
    this.recovery = makeRecoveryDrill(env, {
      incarnation: () =>
        this.runtime.runPromise(Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4())),
      load: () => ctx.storage.get<RecoveryDrillState>("recovery-drill-v1"),
      save: async (state, arm) => {
        const at = arm ? await this.now() : undefined;
        await ctx.storage.transaction(async (transaction) => {
          await transaction.put("recovery-drill-v1", state);
          if (at !== undefined) await transaction.setAlarm(at);
        });
        await ctx.storage.sync();
      },
      reset: () => ctx.abort("recovery-drill: intentional object reset"),
      exclusive: (work) =>
        this.runtime.runPromise(
          withRecoveryInspection((inspect) =>
            Effect.promise(() =>
              ctx.blockConcurrencyWhile(() =>
                work((userId, commandIds) => this.runtime.runPromise(inspect(userId, commandIds))),
              ),
            ),
          ),
        ),
      boatControl: async () => {
        const control = await this.runtime.runPromise(
          Effect.map(BoatRecoveryControl.BoatRecoveryControl, (service) => service),
        );
        return control === null
          ? null
          : {
              inspect: (machineId) => this.runtime.runPromise(control.inspect(machineId)),
              remove: (machineId) => this.runtime.runPromise(control.remove(machineId)),
            };
      },
      rearm: async () => {
        const deferred = this.deferredAlarmAt;
        this.deferredAlarmAt = null;
        if (deferred !== null) await this.setAlarmNoLaterThan(deferred);
        await this.armAlarm();
      },
    });
    // Runner heartbeats are answered without waking a hibernating object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RUNNER_HEARTBEAT_PING, RUNNER_HEARTBEAT_PONG),
    );
    // Builds the engine (loading the log) before any request, and re-arms the
    // alarm if the object went away with work outstanding.
    void ctx.blockConcurrencyWhile(() => this.armAlarm());
  }

  getWorkflowScript(...args: Parameters<ThreadObjectApi["getWorkflowScript"]>) {
    return this.api.getWorkflowScript(...args);
  }

  stopWorkflow(...args: Parameters<ThreadObjectApi["stopWorkflow"]>) {
    return this.api.stopWorkflow(...args);
  }

  // Durable Object RPC dispatches to prototype methods, so each one is spelled out.
  async trash(...args: Parameters<ThreadObjectApi["trash"]>) {
    const reply = await this.api.trash(...args);
    if (
      reply._tag === "ok" &&
      reply.value.state === "trashed" &&
      reply.value.trashId === args[1].trashId
    ) {
      await this.gateway.closeForThreadTrash();
    }
    return reply;
  }

  restore(...args: Parameters<ThreadObjectApi["restore"]>) {
    return this.api.restore(...args);
  }

  purge(...args: Parameters<ThreadObjectApi["purge"]>) {
    return this.api.purge(...args);
  }

  answerSecret(...args: Parameters<ThreadObjectApi["answerSecret"]>) {
    return this.api.answerSecret(...args);
  }
  dispatch(...args: Parameters<ThreadObjectApi["dispatch"]>) {
    return this.api.dispatch(...args);
  }

  launch(...args: Parameters<ThreadObjectApi["launch"]>) {
    return this.api.launch(...args);
  }

  subscribePreparation(...args: Parameters<ThreadObjectApi["subscribePreparation"]>) {
    return this.api.subscribePreparation(...args);
  }

  cancelPreparation(...args: Parameters<ThreadObjectApi["cancelPreparation"]>) {
    return this.api.cancelPreparation(...args);
  }

  recordNativeChildBatch(...args: Parameters<ThreadObjectApi["recordNativeChildBatch"]>) {
    return this.api.recordNativeChildBatch(...args);
  }

  snapshot(...args: Parameters<ThreadObjectApi["snapshot"]>) {
    return this.api.snapshot(...args);
  }

  pull(...args: Parameters<ThreadObjectApi["pull"]>) {
    return this.api.pull(...args);
  }

  pullOwner(...args: Parameters<ThreadObjectApi["pullOwner"]>) {
    return this.api.pullOwner(...args);
  }

  pullTarget(...args: Parameters<ThreadObjectApi["pullTarget"]>) {
    return this.api.pullTarget(...args);
  }

  reservePublication(...args: Parameters<ThreadObjectApi["reservePublication"]>) {
    return this.api.reservePublication(...args);
  }

  releasePublication(...args: Parameters<ThreadObjectApi["releasePublication"]>) {
    return this.api.releasePublication(...args);
  }

  subscribe(...args: Parameters<ThreadObjectApi["subscribe"]>) {
    return this.api.subscribe(...args);
  }

  commandOutput(...args: Parameters<ThreadObjectApi["commandOutput"]>) {
    return this.api.commandOutput(...args);
  }

  summary(...args: Parameters<ThreadObjectApi["summary"]>) {
    return this.api.summary(...args);
  }

  backfill(...args: Parameters<ThreadObjectApi["backfill"]>) {
    return this.api.backfill(...args);
  }

  searchDocuments(...args: Parameters<ThreadObjectApi["searchDocuments"]>) {
    return this.api.searchDocuments(...args);
  }

  contextWorkVisible(...args: Parameters<ThreadObjectApi["contextWorkVisible"]>) {
    return this.api.contextWorkVisible(...args);
  }

  authorizeExecutorTurn(...args: Parameters<ThreadObjectApi["authorizeExecutorTurn"]>) {
    return this.api.authorizeExecutorTurn(...args);
  }

  find(...args: Parameters<ThreadObjectApi["find"]>) {
    return this.api.find(...args);
  }

  diagnostics(...args: Parameters<ThreadObjectApi["diagnostics"]>) {
    return this.api.diagnostics(...args);
  }

  recoveryDrill(userId: string, input: unknown) {
    return this.recovery.command(userId, input);
  }

  requestPullRequestSync(...args: Parameters<ThreadObjectApi["requestPullRequestSync"]>) {
    return this.api.requestPullRequestSync(...args);
  }

  /** The thread's container stopped on its own: its lease is over (see `ThreadRunner.machineExited`). */
  private async machineExited(exit: MachineBackend.MachineExit, generation: number) {
    await this.runtime.runPromise(
      ThreadRunner.ThreadRunner.use((runner) => runner.machineExited(generation, exit)),
    );
    await this.armAlarm();
  }

  contextMatch(...args: Parameters<ThreadObjectApi["contextMatch"]>) {
    return this.api.contextMatch(...args);
  }

  contextTurns(...args: Parameters<ThreadObjectApi["contextTurns"]>) {
    return this.api.contextTurns(...args);
  }

  setMonitors(...args: Parameters<ThreadObjectApi["setMonitors"]>) {
    return this.api.setMonitors(...args);
  }

  browsing(...args: Parameters<ThreadObjectApi["browsing"]>) {
    return this.api.browsing(...args);
  }

  browse(...args: Parameters<ThreadObjectApi["browse"]>) {
    return this.api.browse(...args);
  }

  browsingRecord(...args: Parameters<ThreadObjectApi["browsingRecord"]>) {
    return this.api.browsingRecord(...args);
  }

  /** The ModelGateway reporting a request it served for this thread (see `models/ModelAccess.ts`). */
  async recordModelRequest(record: ModelGatewayRecord) {
    await this.runtime.runPromise(
      recordUnderLock((diagnostics) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => diagnostics.modelRequest(record, now)),
      ),
    );
    const { accountMoved, runId } = record;
    if (accountMoved === undefined || runId === null) return;
    await this.runtime.runPromise(
      ThreadRunner.ThreadRunner.use((runner) => runner.accountMoved(runId, accountMoved)),
    );
  }

  /** The ModelGateway asking whether a harness's token is good right now (see `models/ModelAccess.ts`). */
  authorizeModel(token: string, provider: ModelGatewayProvider) {
    return this.runtime.runPromise(
      ThreadRunner.ThreadRunner.use((runner) => runner.authorizeModel(token, provider)),
    );
  }

  /** The drive API asking whether a Runner's drive token is good, and for what (see `drive/driveRoutes.ts`). */
  authorizeDrive(token: string) {
    return this.runtime.runPromise(
      ThreadRunner.ThreadRunner.use((runner) => runner.authorizeDrive(token)),
    );
  }

  /** The drive API asking whether a Runner may fetch its drive's remote (see `drive/remoteRoutes.ts`). */
  authorizeRemote(token: string) {
    return this.runtime.runPromise(
      ThreadRunner.ThreadRunner.use((runner) => runner.authorizeRemote(token)),
    );
  }

  /** The thread's status line for its agent, from the drive API, which checked its token (#670). */
  statusLine() {
    return this.runtime.runPromise(
      ThreadStatusNotes.ThreadStatusNotes.use((notes) => notes.line).pipe(
        Effect.map((line) => (line === null ? null : statusLineJson.read.encode(line))),
      ),
    );
  }

  /** The agent's status note (`statusLineJson.writeRequest`); answers the stored note's view. */
  async writeStatusNote(input: string) {
    const note = await this.runtime.runPromise(
      ThreadStatusNotes.ThreadStatusNotes.use((notes) =>
        notes.write(statusLineJson.writeRequest.decode(input)),
      ).pipe(Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) })),
    );
    // The new summary revision goes out on the alarm.
    await this.armAlarm();
    return note === null ? null : noteView(note);
  }

  previews(...[actor]: Parameters<ThreadObjectApi["previews"]>) {
    return this.gateway.subscribe(actor.userId);
  }

  previewLink(...[actor, port, handoff]: Parameters<ThreadObjectApi["previewLink"]>) {
    return this.gateway.link(actor.userId, port, handoff);
  }

  browserWatch(...[actor, tabId]: Parameters<ThreadObjectApi["browserWatch"]>) {
    return this.gateway.mirror.watch(actor.userId, tabId);
  }

  async browserInput(
    ...[actor, viewerId, input]: Parameters<ThreadObjectApi["browserInput"]>
  ): Promise<BrowserReply<null>> {
    return this.gateway.mirror.input(actor.userId, viewerId, wire.browserInput.decode(input));
  }

  browserTrail(...[actor]: Parameters<ThreadObjectApi["browserTrail"]>) {
    return this.readTrail(actor.userId, (trail) =>
      Effect.map(trail.steps, (steps) => wire.browserSteps.encode(steps)),
    );
  }

  async browserStep(
    ...[actor, stepId]: Parameters<ThreadObjectApi["browserStep"]>
  ): Promise<BrowserReply<string>> {
    const reply = await this.readTrail(actor.userId, (trail) => trail.recording(stepId));
    if (reply._tag !== "ok") return reply;
    return reply.value === null
      ? { _tag: "unavailable", message: "That step is no longer in the trail." }
      : { _tag: "ok", value: reply.value };
  }

  /** Reads the browser trail for `userId`, who must see the thread. */
  private async readTrail<A>(
    userId: string,
    read: (
      trail: BrowserTrail.BrowserTrail["Service"],
    ) => Effect.Effect<A, BrowserTrail.BrowserTrailError | SqlError>,
  ): Promise<BrowserReply<A>> {
    if (!(await this.canSee(userId))) return { _tag: "unavailable", message: "Thread not found." };
    return this.runtime.runPromise(
      BrowserTrail.BrowserTrail.use(read).pipe(
        Effect.map((value): BrowserReply<A> => ({ _tag: "ok", value })),
        Effect.catchCause((cause) =>
          Effect.logError("browser trail read failed", Cause.pretty(cause)).pipe(
            Effect.as({
              _tag: "unavailable",
              message: "The browser trail is unavailable right now. Try again.",
            } as const),
          ),
        ),
      ),
    );
  }

  /**
   * Whether `userId` can see the thread, within their contexts now: leaving an
   * organization closes its previews and browser too. Personal threads need
   * no lookup, since Personal never goes away.
   */
  private canSee(userId: string) {
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* ThreadEngine.ThreadEngine;
        if (yield* engine.canSee({ userId, contextIds: [PERSONAL_CONTEXT_ID] })) return true;
        const contextIds = yield* (yield* UserDirectory.UserDirectory)
          .forUser(userId)
          .contextIds()
          .pipe(Effect.orElseSucceed(() => []));
        return yield* engine.canSee({ userId, contextIds });
      }),
    );
  }

  /**
   * HTTP into the object, all routed by the Worker: requests to the thread's
   * preview origins, the Runner's preview tunnel, its session API
   * (`session/sessionRoutes.ts`) and attachments (`attachments/runnerAttachments.ts`),
   * and the Runner's socket.
   */
  override async fetch(request: Request) {
    const preview = this.gateway.serve(request);
    if (preview !== null) return preview;
    const { pathname } = new URL(request.url);
    if (pathname === PREVIEW_TUNNEL_PATH) return this.gateway.acceptTunnel();
    if (isRunnerAttachmentsPath(pathname)) {
      return this.runtime.runPromise(serveRunnerAttachments(request, attachmentStorage(this.env)));
    }
    if (isSessionApiPath(pathname)) {
      return handleSessionRequest(request, (effect) => this.runtime.runPromise(effect));
    }
    return acceptRunnerSocket(this.ctx);
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (isRunnerSocket(this.ctx, socket)) await onRunnerMessage(this.runnerHost, socket, message);
    else if (this.gateway.isTunnel(socket)) await this.gateway.onTunnelMessage(socket, message);
    else if (this.gateway.isClient(socket)) await this.gateway.onClientMessage(socket, message);
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string) {
    if (isRunnerSocket(this.ctx, socket))
      await onRunnerClose(this.runnerHost, socket, code, reason);
    else if (this.gateway.isTunnel(socket)) await this.gateway.onTunnelClose(socket, code, reason);
    else if (this.gateway.isClient(socket)) await this.gateway.onClientClose(socket, code, reason);
  }

  override async webSocketError(socket: WebSocket) {
    if (isRunnerSocket(this.ctx, socket)) await onRunnerClose(this.runnerHost, socket);
    else if (this.gateway.isTunnel(socket)) await this.gateway.onTunnelClose(socket);
    else if (this.gateway.isClient(socket)) await this.gateway.onClientClose(socket);
  }

  // Backoff for failing work, in memory: an evicted object starts over, which
  // is what a fresh object should do anyway.
  private stepFailures = 0;
  private deliveryFailures = 0;
  private nextDeliveryAt = 0;
  private eventFailures = 0;
  private nextEventsAt = 0;
  private searchFailures = 0;
  private nextSearchAt = 0;
  private machineFailures = 0;
  private analyticsFailures = 0;
  private sharingFailures = 0;
  private nextAnalyticsAt = 0;

  private now() {
    return this.runtime.runPromise(Clock.currentTimeMillis);
  }

  private deferredAlarmAt: number | null = null;

  /** Sets the alarm for `at` unless one is already due sooner. */
  private async setAlarmNoLaterThan(at: number) {
    if (await this.recovery.preservesAlarm()) {
      this.deferredAlarmAt = Math.min(this.deferredAlarmAt ?? at, at);
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /**
   * Arms the alarm now when there is work: a scripted step, a summary or
   * events to deliver, or lease upkeep. `work` is the Runner's state when the caller
   * just read it.
   */
  private async armAlarm(work?: ThreadRunner.RunnerWork) {
    const now = await this.now();
    const runnerWakeAt = await this.tendRunnerLiveness(now);
    const hasWork = await this.runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* ThreadEngine.ThreadEngine;
        const runner = work ?? (yield* (yield* ThreadRunner.ThreadRunner).work);
        if (
          runner.needsUpkeep ||
          (yield* engine.hasTurnWork) ||
          (yield* engine.hasPendingSummary) ||
          (yield* engine.hasPendingSearch) ||
          (yield* engine.hasPendingEvents) ||
          (yield* Effect.forEach(
            MachineBackend.distinctBackends(yield* MachineBackend.MachineBackend),
            (backend) => backend.pending,
          )).some(Boolean)
        ) {
          return true;
        }
        // Diagnostics re-arm their own alarm while the object lives (a turn's
        // grace, the analytics backoff), so only a fresh object looks for
        // leftovers. A thread not created yet has no tables to read.
        const projection = work === undefined ? yield* engine.projection : null;
        return (
          projection !== null &&
          ((yield* (yield* TurnReports.TurnReports).hasPending(projection)) ||
            (yield* (yield* CloudAnalytics.CloudAnalytics).hasPending))
        );
      }),
    );
    if (hasWork) return this.setAlarmNoLaterThan(now);
    if (runnerWakeAt !== null) await this.setAlarmNoLaterThan(runnerWakeAt);
    // An alarm that fires now sets the next pull request read and share end itself.
    const pullRequestsAt = await this.runtime.runPromise(
      PullRequestSync.PullRequestSync.use((sync) => sync.dueAt),
    );
    if (pullRequestsAt !== null) await this.setAlarmNoLaterThan(pullRequestsAt);
    const statusNoteAt = await this.runtime.runPromise(
      ThreadStatusNotes.ThreadStatusNotes.use((notes) => notes.dueAt(now)),
    );
    if (statusNoteAt !== null) await this.setAlarmNoLaterThan(statusNoteAt);
    const sharingEndsAt = await this.runtime.runPromise(
      ThreadBrowsing.ThreadBrowsing.use((browsing) => browsing.sharingEndsAt),
    );
    if (sharingEndsAt !== null) await this.setAlarmNoLaterThan(sharingEndsAt);
  }

  /**
   * Moves the machine lease toward what the thread needs: asks the backend
   * for a machine until it runs the lease's Runner, ends a released one and
   * stops its machine, and hands a connected Runner its work. Returns when to
   * look again.
   */
  private async tendMachine(log: Evlog.UnitLog, now: number): Promise<number | null> {
    const plan = await this.run(
      log,
      ThreadRunner.ThreadRunner.use((runner) => runner.reconcile),
    );
    if (plan.release !== null) {
      endRunners(this.ctx, plan.release, "This machine is no longer needed.");
      await this.gateway.release(plan.release);
    }
    let wakeAt = plan.wakeAt;
    const ensure = plan.ensure;
    const threadId = this.threadId();
    if (ensure !== null || plan.stop) {
      // The backend call under way, for what a failure is logged as.
      let operation: MachineReport["operation"] = "ensure";
      // `ok`: the backend did what it could; `false` backs off. A machine that is
      // still coming up is retried at the plan's own pace.
      const ok = await this.run(
        log,
        Effect.gen(function* () {
          const backends = yield* MachineBackend.MachineBackend;
          const backend = backends[plan.machineClass];
          operation = ensure === null ? "stop" : "ensure";
          const report = (input: MachineReport) =>
            noteMachine({ ...input, generation: ensure?.generation, runId: plan.runId });
          /** Stops the thread's machine on every backend but `keep`. Cheap where there is none. */
          const stopAll = (keep: MachineBackend.MachineBackendShape | null) =>
            Effect.gen(function* () {
              let stopped = true;
              for (const other of MachineBackend.distinctBackends(backends)) {
                if (other === keep) continue;
                const status = yield* other.stop(threadId);
                // Only a machine there was to stop is news.
                if (status.actual !== "none") yield* report({ operation: "stop", status });
                stopped &&= MachineBackend.isStopped(status);
                if (!stopped) yield* Effect.logInfo("machine not stopped yet", status);
              }
              return stopped;
            });
          if (ensure === null) {
            // A Runner that vanished while the thread still wanted its machine:
            // a machine the backend stopped on its own reached its TTL.
            if (plan.lost && plan.release !== null) {
              operation = "inspect";
              const status = yield* backend.inspect(threadId);
              yield* report({ operation: "inspect", status });
              const release = plan.release;
              if (
                status.desired === "running" &&
                (status.actual === "stopped" || status.actual === "stopping")
              ) {
                yield* recordUnderLock((diagnostics) => diagnostics.refineStop(release, "ttl"));
              }
            }
            operation = "stop";
            return yield* stopAll(null);
          }
          // A thread that changed class lets its machine on the other backend go first.
          operation = "stop";
          if (!(yield* stopAll(backend))) return false;
          operation = "ensure";
          const status = yield* backend.ensure({
            threadId,
            ...ensure,
            machineClass: plan.machineClass,
          });
          yield* report({ operation: "ensure", status });
          if (status.actual !== "running") {
            yield* Effect.logInfo("machine not up yet", status);
            return status.actual !== "failed";
          }
          yield* ThreadRunner.ThreadRunner.use((runner) => runner.ensured(ensure.generation));
          return true;
        }).pipe(
          Effect.catchTags({
            MachineBackendError: (error) =>
              Effect.logError("machine request failed", error.message, error.cause).pipe(
                Effect.andThen(
                  noteMachine({
                    operation,
                    error: error.message,
                    startupProblem: error.startupProblem,
                    generation: ensure?.generation,
                    runId: plan.runId,
                  }),
                ),
                Effect.as(false),
              ),
          }),
        ),
      );
      this.machineFailures = ok ? 0 : this.machineFailures + 1;
      if (!ok) {
        wakeAt = now + retryDelay(this.machineFailures);
      }
    }
    if (plan.busy) {
      const due = await this.refreshMachine(log, now, threadId, plan.machineClass);
      if (due !== null) wakeAt = wakeAt === null ? due : Math.min(wakeAt, due);
    }
    await pushRunnerWork(this.runnerHost);
    return wakeAt;
  }

  /**
   * Pushes a working machine's TTL out when it is due; returns when it is due
   * next. In memory: a woken object refreshes at once, which is harmless.
   */
  private lastRefreshAt = 0;
  private async refreshMachine(
    log: Evlog.UnitLog,
    now: number,
    threadId: ThreadId,
    machineClass: ThreadRunner.MachinePlan["machineClass"],
  ): Promise<number | null> {
    const every = await this.run(
      log,
      MachineBackend.MachineBackend.use((backends) =>
        Effect.succeed(backends[machineClass].refreshEveryMs),
      ),
    );
    if (every === null) return null;
    if (now - this.lastRefreshAt >= every) {
      const ok = await this.run(
        log,
        MachineBackend.MachineBackend.use((backends) =>
          backends[machineClass].refresh(threadId),
        ).pipe(
          Effect.as(true),
          Effect.catchTags({
            MachineBackendError: (error) =>
              Effect.logError("machine TTL refresh failed", error.message).pipe(
                Effect.andThen(
                  noteMachine({ operation: "refresh", error: error.message, runId: null }),
                ),
                Effect.as(false),
              ),
          }),
        ),
      );
      // A failed refresh is tried again after the usual backoff, well before the TTL.
      this.lastRefreshAt = ok ? now : now - every + retryDelay(1);
    }
    return this.lastRefreshAt + every;
  }

  /**
   * Closes ended turns and machine sessions into their diagnostic records and
   * analytics events, then sends queued analytics, backing off while PostHog
   * fails. Returns when to look again.
   */
  private async tendDiagnostics(log: Evlog.UnitLog, now: number): Promise<number | null> {
    const finalizeAt = await this.run(
      log,
      Effect.gen(function* () {
        const projection = yield* (yield* ThreadEngine.ThreadEngine).projection;
        if (projection === null) return null;
        return yield* (yield* TurnReports.TurnReports).finalize(projection, now);
      }),
    ).catch(async (cause: unknown) => {
      await this.run(log, Effect.logError("turn diagnostics failed", String(cause)));
      return now + retryDelay(1);
    });
    if (now < this.nextAnalyticsAt) return finalizeAt;
    const sent = await this.run(
      log,
      Effect.gen(function* () {
        if ((yield* (yield* ThreadEngine.ThreadEngine).projection) === null) return [true, false];
        const analytics = yield* CloudAnalytics.CloudAnalytics;
        return [yield* analytics.deliver, yield* analytics.hasPending] as const;
      }),
    );
    this.analyticsFailures = sent[0] ? 0 : this.analyticsFailures + 1;
    this.nextAnalyticsAt = sent[0] ? 0 : now + retryDelay(this.analyticsFailures);
    const analyticsAt = sent[1] ? (sent[0] ? now + STEP_INTERVAL_MS : this.nextAnalyticsAt) : null;
    return analyticsAt === null || finalizeAt === null
      ? (analyticsAt ?? finalizeAt)
      : Math.min(analyticsAt, finalizeAt);
  }

  /**
   * The event outbox (`eventOutbox.ts`), unless it is backing off: committed
   * events to the owner's automations, retried after the usual backoff.
   */
  private async deliverEvents(log: Evlog.UnitLog, now: number) {
    if (now < this.nextEventsAt) return;
    const delivered = await this.run(
      log,
      deliverPendingEvents.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("thread event delivery failed", Cause.pretty(cause)).pipe(
            Effect.as(false),
          ),
        ),
      ),
    );
    this.eventFailures = delivered ? 0 : this.eventFailures + 1;
    this.nextEventsAt = delivered ? 0 : now + retryDelay(this.eventFailures);
  }

  /** The thread's id: its object is named by it. */
  private threadId() {
    const name = this.ctx.id.name;
    if (name === undefined) throw new Error("Thread objects are always named by their thread id.");
    return name as ThreadId;
  }

  /**
   * One provider step, then the outboxes and upkeep. Failures back off instead of
   * throwing: Cloudflare stops retrying a failing alarm after a few attempts,
   * and a turn must not stop for good because one step failed.
   */
  override async alarm(info?: AlarmInvocationInfo) {
    return this.recovery.alarm(info, () =>
      this.runtime.runPromise(
        Evlog.unit("thread.alarm", { thread: { id: this.threadId() } }, (log) => this.tick(log)),
      ),
    );
  }

  /** A step of this object's runtime, on the alarm's wide event. */
  private run<A, E>(
    log: Evlog.UnitLog,
    effect: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Services<typeof this.runtime>>,
  ) {
    return this.runtime.runPromise(Evlog.provideLogger(effect, log));
  }

  private tendRunnerLiveness(now: number) {
    return RunnerLiveness.tend(this.runnerHost, now, now + retryDelay(1), async (cause) => {
      await this.runtime
        .runPromise(Effect.logError("Runner liveness check failed; retrying", String(cause)))
        .catch(() => undefined);
    });
  }

  private async tick(log: Evlog.UnitLog) {
    const now = await this.now();
    const runnerWakeAt = await this.tendRunnerLiveness(now);
    const step = await this.run(
      log,
      ThreadEngine.ThreadEngine.use((engine) => engine.step).pipe(
        Effect.map((more) => ({ ok: true, more })),
        Effect.catchCause((cause) =>
          Effect.logError("thread step failed; retrying", Cause.pretty(cause)).pipe(
            Effect.as({ ok: false, more: true }),
          ),
        ),
      ),
    );
    this.stepFailures = step.ok ? 0 : this.stepFailures + 1;
    // Before the summary goes out: a synced pull request changes the summary too.
    const pullRequestsWakeAt = await this.run(
      log,
      PullRequestSync.PullRequestSync.use((sync) => sync.sync).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("pull request sync failed", Cause.pretty(cause)).pipe(
            Effect.as(now + retryDelay(1)),
          ),
        ),
      ),
    );
    if (now >= this.nextDeliveryAt) {
      const delivered = await this.run(
        log,
        deliverPendingSummary.pipe(
          Effect.catchCause((cause) =>
            Effect.logError("thread summary delivery failed", Cause.pretty(cause)).pipe(
              Effect.as(false),
            ),
          ),
        ),
      );
      this.deliveryFailures = delivered ? 0 : this.deliveryFailures + 1;
      this.nextDeliveryAt = delivered ? 0 : now + retryDelay(this.deliveryFailures);
    }
    await this.deliverEvents(log, now);
    if (now >= this.nextSearchAt) {
      const delivered = await this.run(
        log,
        deliverPendingSearch.pipe(
          Effect.map(() => true),
          Effect.catchCause((cause) =>
            Effect.logError("thread search delivery failed", Cause.pretty(cause)).pipe(
              Effect.as(false),
            ),
          ),
        ),
      );
      this.searchFailures = delivered ? 0 : this.searchFailures + 1;
      this.nextSearchAt = delivered ? 0 : now + retryDelay(this.searchFailures);
    }
    const machineWakeAt = await this.tendMachine(log, now).catch(async (cause: unknown) => {
      await this.run(log, Effect.logError("machine upkeep failed", String(cause)));
      return now + retryDelay(1);
    });
    const diagnosticsWakeAt = await this.tendDiagnostics(log, now);
    // A turn that ended without its status note gets one written (#670).
    const statusNoteWakeAt = await this.run(
      log,
      ThreadStatusNotes.ThreadStatusNotes.use((notes) => notes.tend(now)).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("runtime status note failed", Cause.pretty(cause)).pipe(
            Effect.as(now + retryDelay(1)),
          ),
        ),
      ),
    );
    const sharing = await this.run(
      log,
      ThreadBrowsing.ThreadBrowsing.use((browsing) => browsing.expire).pipe(
        Effect.map((at) => ({ ok: true, at })),
        Effect.catchCause((cause) =>
          Effect.logError("ending shared tabs failed", Cause.pretty(cause)).pipe(
            Effect.as({ ok: false, at: null }),
          ),
        ),
      ),
    );
    this.sharingFailures = sharing.ok ? 0 : this.sharingFailures + 1;
    const sharingWakeAt = sharing.ok ? sharing.at : now + retryDelay(this.sharingFailures);
    // Machine upkeep may have committed events since; they go out on the next firing.
    const eventsAt =
      this.nextEventsAt > 0
        ? this.nextEventsAt
        : (await this.run(
              log,
              ThreadEngine.ThreadEngine.use((engine) => engine.hasPendingEvents),
            ))
          ? now
          : null;
    // A runtime status note gave the summary a new revision after it went out.
    const summaryAt =
      this.nextDeliveryAt > 0
        ? this.nextDeliveryAt
        : (await this.runtime.runPromise(
              ThreadEngine.ThreadEngine.use((engine) => engine.hasPendingSummary),
            ))
          ? now
          : null;
    const due = [
      step.more ? now + (step.ok ? STEP_INTERVAL_MS : retryDelay(this.stepFailures)) : null,
      summaryAt,
      eventsAt,
      this.nextSearchAt > 0
        ? this.nextSearchAt
        : (await this.runtime.runPromise(
              ThreadEngine.ThreadEngine.use((engine) => engine.hasPendingSearch),
            ))
          ? now + STEP_INTERVAL_MS
          : null,
      machineWakeAt,
      runnerWakeAt,
      diagnosticsWakeAt,
      pullRequestsWakeAt,
      sharingWakeAt,
      statusNoteWakeAt,
    ].filter((at) => at !== null);
    if (due.length > 0) await this.setAlarmNoLaterThan(Math.min(...due));
  }
}
