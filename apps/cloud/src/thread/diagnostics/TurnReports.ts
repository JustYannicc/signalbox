import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { hashWorkloadId } from "@t3tools/shared/workloadUsage";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { isHarnessInstance } from "../providerCatalog.ts";
import { isLiveRun } from "../runLifecycle.ts";
import { MachineBackend } from "../runner/MachineBackend.ts";
import * as ThreadStore from "../ThreadStore.ts";
import { CloudAnalytics } from "./CloudAnalytics.ts";
import { DiagnosticsStore } from "./DiagnosticsStore.ts";
import { traceIdOf } from "./traceId.ts";
import {
  epochMs,
  machineSessionProperties,
  turnCompletedProperties,
  turnRecord,
  type TurnRecord,
  turnSummary,
  type TurnSummary,
} from "./turnRecord.ts";

/**
 * Turns what `TurnDiagnostics` recorded into a diagnostic record per turn and
 * the `cloud.*` analytics events. `finalize`, from the object's alarm, closes
 * a turn once it ended (after a short grace, so the ModelGateway's last report
 * lands first): it logs the record under the turn's trace id and queues
 * `cloud.turn.completed`. An ended machine session queues
 * `cloud.machine.session`. Turns from before diagnostics existed have no
 * record and are passed over, so an old thread does not report its history.
 */

/** How long after a turn ends its last model request may still report. */
export const FINALIZE_GRACE_MS = 15_000;
/** Latest turns the diagnostics list shows. */
const LISTED_RUNS = 50;

type Projection = OrchestrationV2ThreadProjection;

export class TurnReports extends Context.Service<
  TurnReports,
  {
    /** Closes ended turns and sessions. Returns when a turn in its grace is due. */
    readonly finalize: (projection: Projection, now: number) => Effect.Effect<number | null>;
    /** Whether `finalize` has a turn or session to close. */
    readonly hasPending: (projection: Projection) => Effect.Effect<boolean>;
    /** The thread's recent turns, newest first. */
    readonly list: (projection: Projection) => Effect.Effect<ReadonlyArray<TurnSummary>>;
    /** One turn's record, by its run id, trace id, or the id of the command that started it. */
    readonly turn: (projection: Projection, key: string) => Effect.Effect<TurnRecord | null>;
  }
>()("@signalbox/cloud/thread/diagnostics/TurnReports") {}

const isHarnessRun = (run: OrchestrationV2Run) =>
  isHarnessInstance(run.providerInstanceId) && run.activeAttemptId !== null;
const isEnded = (run: OrchestrationV2Run) => run.status !== "queued" && !isLiveRun(run);

/** The runs after `through`, oldest first. */
const runsAfter = (projection: Projection, through: number) =>
  projection.runs
    .filter((run) => run.ordinal > through)
    .toSorted((left, right) => left.ordinal - right.ordinal);

const make = Effect.gen(function* () {
  const store = yield* DiagnosticsStore;
  const threads = yield* ThreadStore.ThreadStore;
  const backend = yield* MachineBackend;
  const analytics = yield* CloudAnalytics;
  const crypto = yield* Crypto.Crypto;
  const withCrypto = <A>(effect: Effect.Effect<A, never, Crypto.Crypto>) =>
    Effect.provideService(effect, Crypto.Crypto, crypto);

  // A thread's id, project and owner never change, so neither do their hashes.
  const hashes = new Map<string, string>();
  const hashOnce = (id: string) =>
    Effect.suspend(() => {
      const known = hashes.get(id);
      return known === undefined
        ? Effect.tap(withCrypto(hashWorkloadId(id)), (hash) =>
            Effect.sync(() => hashes.set(id, hash)),
          )
        : Effect.succeed(known);
    });
  const ownerHash = Effect.flatMap(Effect.orDie(threads.owner), (owner) =>
    hashOnce(`user:${owner?.userId ?? "unknown"}`),
  );

  const recordOf = (projection: Projection, run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const diagnostics = yield* store.run(run.id);
      const generations = diagnostics?.generations ?? [];
      const from = epochMs(run.requestedAt) ?? 0;
      const to = (epochMs(run.completedAt) ?? Number.MAX_SAFE_INTEGER) + FINALIZE_GRACE_MS;
      return {
        diagnostics,
        record: turnRecord({
          projection,
          run,
          traceId: diagnostics?.traceId ?? (yield* withCrypto(traceIdOf(run.id))),
          diagnostics,
          sessions: yield* store.sessionsIn(generations),
          log: yield* store.logFor({ runId: run.id, generations, from, to }),
        }),
      };
    });

  const finalizeRuns = (projection: Projection, now: number) =>
    Effect.gen(function* () {
      const through = yield* store.finalizedThrough;
      let reached = through;
      let wakeAt: number | null = null;
      for (const run of runsAfter(projection, through)) {
        if (!isEnded(run)) break;
        if (isHarnessRun(run)) {
          const due = (epochMs(run.completedAt) ?? now) + FINALIZE_GRACE_MS;
          if (now < due) {
            wakeAt = due;
            break;
          }
          const { diagnostics, record } = yield* recordOf(projection, run);
          if (diagnostics !== null) {
            yield* Effect.logInfo("cloud turn diagnostic", record).pipe(
              Effect.annotateLogs({ traceId: record.traceId, runId: run.id }),
            );
          }
          // Only a turn that reached its harness did work worth pricing.
          if (diagnostics !== null && run.startedAt !== null) {
            yield* analytics.enqueue({
              event: "cloud.turn.completed",
              distinctId: yield* ownerHash,
              at: epochMs(run.completedAt) ?? now,
              properties: turnCompletedProperties({
                projection,
                run,
                diagnostics,
                backend: backend.kind === "none" ? null : backend.kind,
                threadHash: yield* hashOnce(projection.thread.id),
                projectHash: yield* hashOnce(projection.thread.projectId),
              }),
            });
          }
        }
        reached = run.ordinal;
      }
      return { through, reached, wakeAt };
    });

  const finalize: TurnReports["Service"]["finalize"] = (projection, now) =>
    Effect.gen(function* () {
      const { through, reached, wakeAt } = yield* finalizeRuns(projection, now);
      if (reached !== through) yield* store.setFinalizedThrough(reached);
      // Sessions are reported before pruning, which keeps only reported ones.
      for (const session of yield* store.unreportedSessions) {
        yield* analytics.enqueue({
          event: "cloud.machine.session",
          distinctId: yield* ownerHash,
          at: session.endedAt ?? now,
          properties: machineSessionProperties(session, yield* hashOnce(projection.thread.id)),
        });
        yield* store.markReported(session.generation);
      }
      if (reached !== through) yield* store.prune(reached);
      return wakeAt;
    });

  const hasPending: TurnReports["Service"]["hasPending"] = (projection) =>
    Effect.gen(function* () {
      const next = runsAfter(projection, yield* store.finalizedThrough)[0];
      if (next !== undefined && isEnded(next)) return true;
      return (yield* store.unreportedSessions).length > 0;
    });

  const harnessRuns = (projection: Projection) =>
    projection.runs.filter(isHarnessRun).toSorted((left, right) => right.ordinal - left.ordinal);

  const list: TurnReports["Service"]["list"] = (projection) =>
    Effect.gen(function* () {
      const traceIds = yield* store.traceIds;
      return yield* Effect.forEach(harnessRuns(projection).slice(0, LISTED_RUNS), (run) =>
        Effect.map(
          Effect.suspend(() => {
            const known = traceIds.get(run.id);
            return known === undefined ? withCrypto(traceIdOf(run.id)) : Effect.succeed(known);
          }),
          (traceId) => turnSummary(projection, run, traceId),
        ),
      );
    });

  const turn: TurnReports["Service"]["turn"] = (projection, key) =>
    Effect.gen(function* () {
      const runs = harnessRuns(projection);
      const byRun = (runId: string | null) => runs.find((run) => run.id === runId);
      const commandTrace = yield* store.traceOfCommand(key);
      const run =
        byRun(key) ??
        byRun(yield* store.runOfTrace(key)) ??
        (commandTrace === null ? undefined : byRun(yield* store.runOfTrace(commandTrace)));
      return run === undefined ? null : (yield* recordOf(projection, run)).record;
    });

  return TurnReports.of({ finalize, hasPending, list, turn });
});

export const layer = Layer.effect(TurnReports, make);
