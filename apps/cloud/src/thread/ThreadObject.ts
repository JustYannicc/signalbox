import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { PREVIEW_TUNNEL_PATH } from "@signalbox/runner-protocol/PreviewTunnel";
import {
  type ModelGatewayProvider,
  RUNNER_HEARTBEAT_PING,
  RUNNER_HEARTBEAT_PONG,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import { DurableObject } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import type { ModelGatewayRecord } from "../modelGateway/modelGatewayRecord.ts";
import type { DriveObjectNamespace } from "../drive/DriveDirectory.ts";
import type { PackBucket } from "../drive/DrivePacks.ts";
import * as Platform from "../platform.ts";
import { PreviewGateway } from "./preview/PreviewGateway.ts";
import { type PreviewEnv, previewSettings } from "./preview/previewHost.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as CloudAnalytics from "./diagnostics/CloudAnalytics.ts";
import * as DiagnosticsStore from "./diagnostics/DiagnosticsStore.ts";
import * as TurnDiagnostics from "./diagnostics/TurnDiagnostics.ts";
import * as TurnReports from "./diagnostics/TurnReports.ts";
import { layerFromEnv as layerMachineBackend } from "./runner/machineBackends.ts";
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
import * as SessionRows from "./session/SessionRows.ts";
import { handleSessionRequest, isSessionApiPath } from "./session/sessionRoutes.ts";
import { deliverPendingSummary } from "./summaryOutbox.ts";
import { THREAD_OBJECT_JURISDICTION, type ThreadObjectApi } from "./ThreadDirectory.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import { makeThreadObjectApi } from "./threadObjectApi.ts";
import * as ThreadStore from "./ThreadStore.ts";

/**
 * One per thread, named by its thread id, always in the EU jurisdiction. It
 * owns the thread's event log and receipts (see `ThreadEngine`). Scripted
 * turns run here; Claude and Codex turns run on a machine whose Runner dials
 * in over a WebSocket (see `runner/`).
 *
 * Work after a commit runs from the object's alarm: one scripted step per
 * firing, the summary outbox, then the machine lease. Alarms are durable and
 * retried, and the object re-arms one whenever it wakes with work
 * outstanding, so neither an eviction nor a deploy strands a turn, a sidebar
 * update or a machine.
 *
 * It is also the PreviewGateway's brain (`preview/PreviewGateway.ts`): the
 * Runner's tunnel lands here, and so does every request to the thread's
 * preview origins.
 */

export interface ThreadObjectEnv
  extends MachineBackend.MachineBackendEnv, CloudAnalytics.CloudAnalyticsEnv, PreviewEnv {
  /** Set by `vp run dev` only. Local workerd has no jurisdictions. */
  readonly LOCAL_WORKERD?: string;
  readonly USERS: UserDirectory.UserObjectNamespace;
  /** Drives' objects and packs (`drive/`). Turns work in a drive only when both are bound. */
  readonly DRIVES?: DriveObjectNamespace;
  readonly DRIVE_PACKS?: PackBucket;
}

/** Time between streamed chunks of a scripted reply. */
const STEP_INTERVAL_MS = 120;
/** Wait after the `failures`th failure in a row: 5 s, doubling, at most 5 min. */
const retryDelay = (failures: number) => Math.min(5_000 * 2 ** (failures - 1), 300_000);

type MachineReport = Omit<
  Parameters<TurnDiagnostics.TurnDiagnostics["Service"]["machineReported"]>[0],
  "generation" | "runId" | "now"
>;

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
) =>
  Effect.flatMap(ThreadStore.ThreadStore, (store) =>
    recordUnderLock((diagnostics) =>
      Effect.gen(function* () {
        const generation = input.generation ?? (yield* Effect.orDie(store.machine)).generation;
        const now = yield* Clock.currentTimeMillis;
        yield* diagnostics.machineReported({ ...input, generation, now });
      }),
    ),
  );

// The whole storage, not just `storage.sql`: commits and migrations run in transactions.
const makeRuntime = (
  storage: DurableObjectStorage,
  env: ThreadObjectEnv,
  previews: PreviewGateway,
) =>
  ManagedRuntime.make(
    ThreadRunner.layer.pipe(
      Layer.provide(
        Layer.succeed(ThreadRunner.PreviewHold, {
          held: Effect.sync(() => previews.held),
          lastActiveAt: Effect.sync(() => previews.lastActiveAt),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ThreadRunner.ThreadDrives, {
          enabled: env.DRIVES !== undefined && env.DRIVE_PACKS !== undefined,
        }),
      ),
      Layer.provideMerge(ThreadEngine.layer),
      Layer.provideMerge(Layer.mergeAll(TurnDiagnostics.layer, TurnReports.layer)),
      Layer.provideMerge(CloudAnalytics.layerFromEnv(env)),
      Layer.provideMerge(layerMachineBackend(env)),
      Layer.provideMerge(DiagnosticsStore.layer),
      Layer.provideMerge(ThreadStore.layerMachineRecords),
      Layer.provideMerge(Layer.mergeAll(ThreadStore.layer, SessionRows.layer)),
      Layer.provideMerge(
        UserDirectory.layerDurableObjects(env.USERS, { localWorkerd: env.LOCAL_WORKERD === "1" }),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          SqliteClient.layer({ storage }),
          Platform.layerCrypto,
          FetchHttpClient.layer,
        ),
      ),
    ),
  );

export class ThreadObject extends DurableObject<ThreadObjectEnv> implements ThreadObjectApi {
  private readonly runtime: ReturnType<typeof makeRuntime>;
  private readonly api: ReturnType<typeof makeThreadObjectApi>;
  private readonly runnerHost: RunnerSocketHost;
  private readonly gateway: PreviewGateway;

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
      leaseToken: (generation, token) =>
        this.runtime.runPromise(
          ThreadRunner.ThreadRunner.use((runner) => runner.leaseToken(generation, token)),
        ),
      canSee: (userId) =>
        this.runtime.runPromise(
          ThreadEngine.ThreadEngine.use((engine) => engine.canSee({ userId })),
        ),
      holdChanged: () => this.armAlarm(),
    });
    this.runtime = makeRuntime(ctx.storage, env, this.gateway);
    this.runnerHost = {
      ctx,
      run: (effect) => this.runtime.runPromise(effect),
      afterChange: (work) => this.armAlarm(work),
    };
    this.api = makeThreadObjectApi(
      (effect) => this.runtime.runPromise(effect),
      async () => this.armAlarm(await pushRunnerWork(this.runnerHost)),
    );
    // Runner heartbeats are answered without waking a hibernating object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RUNNER_HEARTBEAT_PING, RUNNER_HEARTBEAT_PONG),
    );
    // Builds the engine (loading the log) before any request, and re-arms the
    // alarm if the object went away with work outstanding.
    void ctx.blockConcurrencyWhile(() => this.armAlarm());
  }

  // Durable Object RPC dispatches to prototype methods, so each one is spelled out.
  dispatch(...args: Parameters<ThreadObjectApi["dispatch"]>) {
    return this.api.dispatch(...args);
  }

  launch(...args: Parameters<ThreadObjectApi["launch"]>) {
    return this.api.launch(...args);
  }

  snapshot(...args: Parameters<ThreadObjectApi["snapshot"]>) {
    return this.api.snapshot(...args);
  }

  subscribe(...args: Parameters<ThreadObjectApi["subscribe"]>) {
    return this.api.subscribe(...args);
  }

  summary(...args: Parameters<ThreadObjectApi["summary"]>) {
    return this.api.summary(...args);
  }

  diagnostics(...args: Parameters<ThreadObjectApi["diagnostics"]>) {
    return this.api.diagnostics(...args);
  }

  /** The ModelGateway reporting a request it served for this thread (see `modelGrants.ts`). */
  async recordModelRequest(record: ModelGatewayRecord) {
    await this.runtime.runPromise(
      recordUnderLock((diagnostics) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => diagnostics.modelRequest(record, now)),
      ),
    );
  }

  /** The ModelGateway asking whether a harness's token is good right now (see `modelGrants.ts`). */
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

  previews(...[actor]: Parameters<ThreadObjectApi["previews"]>) {
    return this.gateway.subscribe(actor.userId);
  }

  previewLink(...[actor, port]: Parameters<ThreadObjectApi["previewLink"]>) {
    return this.gateway.link(actor.userId, port);
  }

  /**
   * HTTP into the object, all routed by the Worker: requests to the thread's
   * preview origins, the Runner's preview tunnel, its session API
   * (`session/sessionRoutes.ts`), and the Runner's socket.
   */
  override async fetch(request: Request) {
    const preview = this.gateway.serve(request);
    if (preview !== null) return preview;
    const { pathname } = new URL(request.url);
    if (pathname === PREVIEW_TUNNEL_PATH) return this.gateway.acceptTunnel();
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
  private machineFailures = 0;
  private analyticsFailures = 0;
  private nextAnalyticsAt = 0;

  private now() {
    return this.runtime.runPromise(Clock.currentTimeMillis);
  }

  /** Sets the alarm for `at` unless one is already due sooner. */
  private async setAlarmNoLaterThan(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /**
   * Arms the alarm now when there is work: a scripted step, a summary to
   * deliver, or lease upkeep. `work` is the Runner's state when the caller
   * just read it.
   */
  private async armAlarm(work?: ThreadRunner.RunnerWork) {
    const hasWork = await this.runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* ThreadEngine.ThreadEngine;
        const runner = work ?? (yield* (yield* ThreadRunner.ThreadRunner).work);
        if (
          runner.needsUpkeep ||
          (yield* engine.hasTurnWork) ||
          (yield* engine.hasPendingSummary) ||
          (yield* (yield* MachineBackend.MachineBackend).pending)
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
    if (hasWork) await this.setAlarmNoLaterThan(await this.now());
  }

  /**
   * Moves the machine lease toward what the thread needs: asks the backend
   * for a machine until it runs the lease's Runner, ends a released one and
   * stops its machine, and hands a connected Runner its work. Returns when to
   * look again.
   */
  private async tendMachine(now: number): Promise<number | null> {
    const plan = await this.runtime.runPromise(
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
      const ok = await this.runtime.runPromise(
        Effect.gen(function* () {
          const backend = yield* MachineBackend.MachineBackend;
          operation = ensure === null ? "stop" : "ensure";
          const report = (input: MachineReport) =>
            noteMachine({ ...input, generation: ensure?.generation, runId: plan.runId });
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
            const status = yield* backend.stop(threadId);
            yield* report({ operation: "stop", status });
            if (
              status.actual === "none" ||
              status.actual === "stopped" ||
              status.actual === "stopping"
            ) {
              return true;
            }
            yield* Effect.logInfo("machine not stopped yet", status);
            return false;
          }
          const status = yield* backend.ensure({ threadId, ...ensure });
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
      const due = await this.refreshMachine(now, threadId);
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
  private async refreshMachine(now: number, threadId: ThreadId): Promise<number | null> {
    const every = await this.runtime.runPromise(
      MachineBackend.MachineBackend.use((backend) => Effect.succeed(backend.refreshEveryMs)),
    );
    if (every === null) return null;
    if (now - this.lastRefreshAt >= every) {
      const ok = await this.runtime.runPromise(
        MachineBackend.MachineBackend.use((backend) => backend.refresh(threadId)).pipe(
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
  private async tendDiagnostics(now: number): Promise<number | null> {
    const finalizeAt = await this.runtime
      .runPromise(
        Effect.gen(function* () {
          const projection = yield* (yield* ThreadEngine.ThreadEngine).projection;
          if (projection === null) return null;
          return yield* (yield* TurnReports.TurnReports).finalize(projection, now);
        }),
      )
      .catch(async (cause: unknown) => {
        await this.runtime.runPromise(Effect.logError("turn diagnostics failed", String(cause)));
        return now + retryDelay(1);
      });
    if (now < this.nextAnalyticsAt) return finalizeAt;
    const sent = await this.runtime.runPromise(
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

  /** The thread's id: its object is named by it. */
  private threadId() {
    const name = this.ctx.id.name;
    if (name === undefined) throw new Error("Thread objects are always named by their thread id.");
    return name as ThreadId;
  }

  /**
   * One provider step, then the summary outbox. Failures back off instead of
   * throwing: Cloudflare stops retrying a failing alarm after a few attempts,
   * and a turn must not stop for good because one step failed.
   */
  override async alarm() {
    const now = await this.now();
    const step = await this.runtime.runPromise(
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
    if (now >= this.nextDeliveryAt) {
      const delivered = await this.runtime.runPromise(
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
    const machineWakeAt = await this.tendMachine(now).catch(async (cause: unknown) => {
      await this.runtime.runPromise(Effect.logError("machine upkeep failed", String(cause)));
      return now + retryDelay(1);
    });
    const diagnosticsWakeAt = await this.tendDiagnostics(now);
    const due = [
      step.more ? now + (step.ok ? STEP_INTERVAL_MS : retryDelay(this.stepFailures)) : null,
      this.nextDeliveryAt > 0 ? this.nextDeliveryAt : null,
      machineWakeAt,
      diagnosticsWakeAt,
    ].filter((at) => at !== null);
    if (due.length > 0) await this.setAlarmNoLaterThan(Math.min(...due));
  }
}
