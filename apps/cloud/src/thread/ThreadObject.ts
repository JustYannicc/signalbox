import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import {
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

import * as Platform from "../platform.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
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
 */

export interface ThreadObjectEnv extends MachineBackend.MachineBackendEnv {
  /** Set by `vp run dev` only. Local workerd has no jurisdictions. */
  readonly LOCAL_WORKERD?: string;
  readonly USERS: UserDirectory.UserObjectNamespace;
}

/** Time between streamed chunks of a scripted reply. */
const STEP_INTERVAL_MS = 120;
/** Wait after the `failures`th failure in a row: 5 s, doubling, at most 5 min. */
const retryDelay = (failures: number) => Math.min(5_000 * 2 ** (failures - 1), 300_000);

// The whole storage, not just `storage.sql`: commits and migrations run in transactions.
const makeRuntime = (storage: DurableObjectStorage, env: ThreadObjectEnv) =>
  ManagedRuntime.make(
    ThreadRunner.layer.pipe(
      Layer.provideMerge(ThreadEngine.layer),
      Layer.provideMerge(ThreadStore.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          UserDirectory.layerDurableObjects(env.USERS, { localWorkerd: env.LOCAL_WORKERD === "1" }),
          MachineBackend.layerFromEnv(env).pipe(Layer.provide(FetchHttpClient.layer)),
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(SqliteClient.layer({ storage }), Platform.layerCrypto)),
    ),
  );

export class ThreadObject extends DurableObject<ThreadObjectEnv> implements ThreadObjectApi {
  private readonly runtime: ReturnType<typeof makeRuntime>;
  private readonly api: ThreadObjectApi;
  private readonly runnerHost: RunnerSocketHost;

  constructor(ctx: DurableObjectState, env: ThreadObjectEnv) {
    super(ctx, env);
    // Created only through `jurisdiction("eu")`; anything else is a routing bug.
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== THREAD_OBJECT_JURISDICTION) {
      throw new Error("Thread objects must live in the EU jurisdiction.");
    }
    this.runtime = makeRuntime(ctx.storage, env);
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

  /** The Runner's socket. The Worker forwards only upgrades on `RUNNER_CONNECT_PATH` here. */
  override async fetch() {
    return acceptRunnerSocket(this.ctx);
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (isRunnerSocket(this.ctx, socket)) await onRunnerMessage(this.runnerHost, socket, message);
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string) {
    if (isRunnerSocket(this.ctx, socket))
      await onRunnerClose(this.runnerHost, socket, code, reason);
  }

  override async webSocketError(socket: WebSocket) {
    if (isRunnerSocket(this.ctx, socket)) await onRunnerClose(this.runnerHost, socket);
  }

  // Backoff for failing work, in memory: an evicted object starts over, which
  // is what a fresh object should do anyway.
  private stepFailures = 0;
  private deliveryFailures = 0;
  private nextDeliveryAt = 0;
  private ensureFailures = 0;

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
        return (
          runner.needsUpkeep || (yield* engine.hasTurnWork) || (yield* engine.hasPendingSummary)
        );
      }),
    );
    if (hasWork) await this.setAlarmNoLaterThan(await this.now());
  }

  /**
   * Moves the machine lease toward what the thread needs: asks the backend
   * for a machine, ends a released one, and hands a connected Runner its
   * work. Returns when to look again.
   */
  private async tendMachine(now: number): Promise<number | null> {
    const plan = await this.runtime.runPromise(
      ThreadRunner.ThreadRunner.use((runner) => runner.reconcile),
    );
    if (plan.release !== null)
      endRunners(this.ctx, plan.release, "This machine is no longer needed.");
    let wakeAt = plan.wakeAt;
    const ensure = plan.ensure;
    if (ensure !== null) {
      const threadId = this.threadId();
      const ok = await this.runtime.runPromise(
        Effect.gen(function* () {
          const backend = yield* MachineBackend.MachineBackend;
          if (backend.ensure === null) {
            return yield* new MachineBackend.MachineBackendError({
              message: "This cloud has no machine backend.",
            });
          }
          yield* backend.ensure({ threadId, ...ensure });
          yield* ThreadRunner.ThreadRunner.use((runner) => runner.ensured(ensure.generation));
          return true;
        }).pipe(
          Effect.catchTags({
            MachineBackendError: (error) =>
              Effect.logError("machine request failed", error.message, error.cause).pipe(
                Effect.as(false),
              ),
          }),
        ),
      );
      this.ensureFailures = ok ? 0 : this.ensureFailures + 1;
      if (!ok) {
        const retryAt = now + retryDelay(this.ensureFailures);
        wakeAt = wakeAt === null ? retryAt : Math.min(wakeAt, retryAt);
      }
    }
    await pushRunnerWork(this.runnerHost);
    return wakeAt;
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
    const due = [
      step.more ? now + (step.ok ? STEP_INTERVAL_MS : retryDelay(this.stepFailures)) : null,
      this.nextDeliveryAt > 0 ? this.nextDeliveryAt : null,
      machineWakeAt,
    ].filter((at) => at !== null);
    if (due.length > 0) await this.setAlarmNoLaterThan(Math.min(...due));
  }
}
