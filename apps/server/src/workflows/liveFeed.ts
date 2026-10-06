import type { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { forkParked } from "../serverActivation.ts";
import { toJson } from "./json.ts";

/** What changed, so live views recompute only when it shows in them. */
export type Change =
  /** Saved, published, discarded, switched or deleted: event triggers re-read it. */
  | { readonly kind: "definition"; readonly automationId: string }
  /** Something else on the automation, like its next cron time or webhook token. */
  | { readonly kind: "automation"; readonly automationId: string }
  /**
   * Its runs. `summary` says whether what run lists show changed (a run
   * started or ended, a question started or stopped waiting); a step moving
   * along shows only in the run itself. No `runId` means runs were removed.
   */
  | {
      readonly kind: "runs";
      readonly automationId: string;
      readonly runId?: string;
      readonly summary: boolean;
    };

/** Changes within this window reach subscribers as one recompute. A busy run changes many times a second. */
export const COALESCE_WINDOW = "100 millis";

/** The automation list shows each automation and its latest run's summary. */
export const listShows = (change: Change) => change.kind !== "runs" || change.summary;

/** An automation's page shows it and its recent runs' summaries. */
export const automationShows = (automationId: string) => (change: Change) =>
  change.automationId === automationId && listShows(change);

/** A run's page shows its steps. */
export const runShows = (runId: string) => (change: Change) =>
  change.kind === "runs" && change.runId === runId;

interface View {
  readonly read: Effect.Effect<unknown, AutomationError>;
  readonly shows: (change: Change) => boolean;
  /** Keep showing the last value when a later read fails, instead of failing subscribers. */
  readonly keepOnFailure: boolean;
  readonly ref: SubscriptionRef.SubscriptionRef<
    Result.Result<unknown, AutomationError> | undefined
  >;
  /** One read at a time, so a slow older read never overwrites a newer one. */
  readonly lock: Semaphore.Semaphore;
  watchers: number;
  /** The last value sent, as JSON, so unchanged recomputes send nothing. */
  sent: string | undefined;
}

/**
 * Turns the engine's change notifications into live views. Changes are
 * batched per window. Each view (the list, one automation, one run) is read
 * once per batch that shows in it and shared by all its subscribers, exists
 * only while someone watches it, and sends only values that changed.
 */
export const makeLiveFeed = (changes: PubSub.PubSub<Change>) =>
  Effect.gen(function* () {
    const batches = yield* PubSub.unbounded<ReadonlyArray<Change>>();
    const incoming = yield* PubSub.subscribe(changes);
    yield* forkParked(
      Effect.gen(function* () {
        const first = yield* PubSub.takeAll(incoming);
        yield* Effect.sleep(COALESCE_WINDOW);
        const rest = yield* PubSub.takeUpTo(incoming, Number.POSITIVE_INFINITY);
        yield* PubSub.publish(batches, [...first, ...rest]);
      }).pipe(Effect.forever),
    );

    const views = new Map<string, View>();

    const refresh = (view: View) =>
      view.lock.withPermits(1)(
        Effect.gen(function* () {
          const result = yield* Effect.result(view.read);
          if (Result.isFailure(result)) {
            const previous = yield* SubscriptionRef.get(view.ref);
            if (view.keepOnFailure && previous !== undefined && Result.isSuccess(previous)) {
              return yield* Effect.logWarning("Automation view couldn't refresh", {
                cause: result.failure,
              });
            }
            view.sent = undefined;
            return yield* SubscriptionRef.set(view.ref, result);
          }
          const sent = toJson(result.success);
          if (sent === view.sent) return;
          view.sent = sent;
          yield* SubscriptionRef.set(view.ref, result);
        }),
      );

    const batchSubscription = yield* PubSub.subscribe(batches);
    yield* forkParked(
      Stream.runForEach(Stream.fromSubscription(batchSubscription), (batch) =>
        Effect.forEach(
          [...views.values()].filter((view) => batch.some(view.shows)),
          refresh,
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );

    const watch = <A>(
      key: string,
      read: Effect.Effect<A, AutomationError>,
      shows: (change: Change) => boolean,
      options: { readonly keepOnFailure?: boolean } = {},
    ): Stream.Stream<A, AutomationError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const view = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const existing = views.get(key);
              if (existing) {
                existing.watchers += 1;
                return { view: existing, fresh: false };
              }
              const created: View = {
                read,
                shows,
                keepOnFailure: options.keepOnFailure === true,
                ref: yield* SubscriptionRef.make<
                  Result.Result<unknown, AutomationError> | undefined
                >(undefined),
                lock: yield* Semaphore.make(1),
                watchers: 1,
                sent: undefined,
              };
              views.set(key, created);
              return { view: created, fresh: true };
            }),
            ({ view }) =>
              Effect.sync(() => {
                view.watchers -= 1;
                if (view.watchers === 0 && views.get(key) === view) views.delete(key);
              }),
          );
          if (view.fresh) yield* refresh(view.view);
          return SubscriptionRef.changes(view.view.ref).pipe(
            Stream.filter((value) => value !== undefined),
            Stream.mapEffect((value) =>
              Result.isSuccess(value)
                ? Effect.succeed(value.success as A)
                : Effect.fail(value.failure),
            ),
          );
        }),
      );

    return { watch };
  });
