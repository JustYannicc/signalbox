import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { DurableObject } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as Platform from "../platform.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { deliverPendingSummary } from "./summaryOutbox.ts";
import { THREAD_OBJECT_JURISDICTION, type ThreadObjectApi } from "./ThreadDirectory.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import { makeThreadObjectApi } from "./threadObjectApi.ts";
import * as ThreadStore from "./ThreadStore.ts";

/**
 * One per thread, named by its thread id, always in the EU jurisdiction. It
 * owns the thread's event log and receipts (see `ThreadEngine`) and drives its
 * turns with the scripted provider.
 *
 * Work after a commit runs from the object's alarm: one provider step per
 * firing, then the summary outbox. Alarms are durable and retried, and the
 * object re-arms one whenever it wakes with work outstanding, so neither an
 * eviction nor a deploy strands a turn or a sidebar update.
 */

export interface ThreadObjectEnv {
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
    ThreadEngine.layer.pipe(
      Layer.provideMerge(ThreadStore.layer),
      Layer.provideMerge(
        UserDirectory.layerDurableObjects(env.USERS, { localWorkerd: env.LOCAL_WORKERD === "1" }),
      ),
      Layer.provideMerge(Layer.mergeAll(SqliteClient.layer({ storage }), Platform.layerCrypto)),
    ),
  );

export class ThreadObject extends DurableObject<ThreadObjectEnv> implements ThreadObjectApi {
  private readonly runtime: ReturnType<typeof makeRuntime>;
  private readonly api: ThreadObjectApi;

  constructor(ctx: DurableObjectState, env: ThreadObjectEnv) {
    super(ctx, env);
    // Created only through `jurisdiction("eu")`; anything else is a routing bug.
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== THREAD_OBJECT_JURISDICTION) {
      throw new Error("Thread objects must live in the EU jurisdiction.");
    }
    this.runtime = makeRuntime(ctx.storage, env);
    this.api = makeThreadObjectApi(
      (effect) => this.runtime.runPromise(effect),
      () => this.armAlarm(),
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

  // Backoff for failing work, in memory: an evicted object starts over, which
  // is what a fresh object should do anyway.
  private stepFailures = 0;
  private deliveryFailures = 0;
  private nextDeliveryAt = 0;

  private now() {
    return this.runtime.runPromise(Clock.currentTimeMillis);
  }

  /** Sets the alarm for `at` unless one is already due sooner. */
  private async setAlarmNoLaterThan(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /** Arms the alarm now when there is work (a turn to drive, a summary to deliver). */
  private async armAlarm() {
    const hasWork = await this.runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* ThreadEngine.ThreadEngine;
        return (yield* engine.hasTurnWork) || (yield* engine.hasPendingSummary);
      }),
    );
    if (hasWork) await this.setAlarmNoLaterThan(await this.now());
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
    const due = [
      step.more ? now + (step.ok ? STEP_INTERVAL_MS : retryDelay(this.stepFailures)) : null,
      this.nextDeliveryAt > 0 ? this.nextDeliveryAt : null,
    ].filter((at) => at !== null);
    if (due.length > 0) await this.setAlarmNoLaterThan(Math.min(...due));
  }
}
