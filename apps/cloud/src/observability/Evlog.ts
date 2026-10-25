import { EvlogLogger, loggerLayer, set, useLogger, WaitUntil, withLogger } from "evlog/effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type CloudFields, requestOptions } from "./evlogWorkers.ts";

export type { CloudFields, Route } from "./evlogWorkers.ts";
export { init, requestOptions } from "./evlogWorkers.ts";

/**
 * The cloud's wide events (#285), on evlog's Cloudflare Workers and Effect
 * integrations:
 *
 * - Each Worker request is one event (`withEvlog` in `worker.ts`, and the
 *   ModelGateway's `worker.ts`, whose event is the pool call).
 * - Durable Object alarms, turns and Executor calls are units of their own
 *   (`unit`, `withUnit`).
 * - `Effect.log*` inside a unit lands on its event (`layer`); outside one it
 *   goes to the console as before.
 *
 * Use `CloudFields` names for the shared dimensions, so one query finds a
 * person's or a thread's events across every unit. Never put text a person or
 * agent wrote on an event (`content.ts`).
 */

/** The logger of one unit's wide event. */
export type UnitLog = EvlogLogger["Service"];

/** `Effect.log*` into the current unit's event. Every cloud runtime provides it. */
export const layer = loggerLayer();

/**
 * A Durable Object's units hand their drains to `ctx.waitUntil` instead of
 * waiting on them, so an alarm never waits on Sentry or PostHog. Every
 * object's runtime provides it.
 */
export const layerWaitUntil = (ctx: { readonly waitUntil: (promise: Promise<unknown>) => void }) =>
  Layer.succeed(WaitUntil, (promise) => ctx.waitUntil(promise));

/** Adds fields to the current unit's event. Does nothing outside a unit. */
export const annotate = (fields: CloudFields) => set<CloudFields>(fields);

/** The current unit's logger. */
export const logger = useLogger<CloudFields>();

/** `effect` with `log` as its unit, for work a unit hands to another runtime call. */
export const provideLogger = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  log: UnitLog | undefined,
): Effect.Effect<A, E, R> =>
  log === undefined ? effect : Effect.provideService(effect, EvlogLogger, log);

/** A context holding `log`, for handlers that take one (`HttpEffect.toWebHandler`). */
export const loggerContext = (log: UnitLog) => Context.make(EvlogLogger, log);

/**
 * `effect` as its own unit, `action`, starting with `fields`. Without a
 * `layerWaitUntil` the unit waits for its drains before it settles, which only
 * a one-shot process (a CI script, a test) wants.
 */
export const withUnit =
  (action: string, fields: CloudFields = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(withLogger(action, { ...requestOptions, fields: { ...fields } }));

/**
 * A unit around work that isn't one Effect, such as a Durable Object alarm
 * that runs several steps on its runtime: `body` gets the unit's logger to
 * pass to each step (`provideLogger`).
 */
export const unit = <A>(
  action: string,
  fields: CloudFields,
  body: (log: UnitLog) => Promise<A>,
): Effect.Effect<A> =>
  EvlogLogger.use((log) => Effect.promise(() => body(log))).pipe(withUnit(action, fields));
