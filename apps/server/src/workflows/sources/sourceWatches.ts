import {
  type AutomationError,
  type WorkflowSourceWatch,
  type AutomationNotice,
  type AutomationSourceStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { automationDefaults } from "../columns.ts";
import { errorMessage, logFailure } from "../errors.ts";
import { fromJson, toJson } from "../json.ts";
import { transientCause } from "../stepPolicy.ts";
import { isoAt } from "../time.ts";
import type { AutomationRow } from "../WorkflowStore.ts";
import type { SourceRow, SourceStore } from "./sourceStore.ts";
import {
  diffSnapshots,
  everyMsOf,
  listOf,
  snapshotOf,
  sourceIdOf,
  type Snapshot,
  type SourceChange,
} from "./watch.ts";

/**
 * Watched sources: anything an Executor operation lists, checked once per
 * source however many automations and runs watch it, and diffed by key into
 * `source.item.*` events that event triggers and `w.waitFor` take like any
 * other event.
 *
 * Who watches is worked out on every engine tick from the live automations'
 * triggers and the running runs' `waitFor` steps, so nothing registers or
 * unregisters. A source nobody watches stops being read, and is forgotten an
 * hour later. The first read of a new source only records what's there.
 * Reads are stored before their events go out, so a restart never replays.
 *
 * A quiet source is read less often (up to 4× its `every`), a failing one
 * backs off (doubling, honoring Retry-After, up to an hour), and after
 * `MAX_FAILURES` failed reads in a row it pauses and its watchers' owners are
 * told once. A pause lifts when someone new watches it: an automation saved
 * again, a new run, or a server restart.
 */

const MAX_FAILURES = 5;
const QUIET_FACTOR = 1.5;
const QUIET_MAX = 4;
const MAX_BACKOFF_MS = 60 * 60_000;
/** Sources nobody watched for this long are deleted, with what they last read. */
const FORGET_AFTER_MS = 60 * 60_000;
/** How often watched sources are marked as wanted and unwanted ones pruned. */
const PRUNE_EVERY_MS = 10 * 60_000;
/** Items kept per read; a longer list counts its first ones. */
const MAX_ITEMS = 1_000;

/** One automation or run watching a source. */
export interface Watcher {
  /** Stable per watcher: a new id is someone new watching, which lifts a pause. */
  readonly id: string;
  /** The run watching, for a `waitFor` step; absent for a trigger. */
  readonly runId?: string;
  readonly projectId: string;
  readonly watch: WorkflowSourceWatch;
  /** Whose watch it is: its owner hears about a pause, and its access decides approvals. */
  readonly automation: AutomationRow;
}

export interface SourceEnvelope extends Readonly<Record<string, unknown>> {
  readonly event: string;
  readonly id: string;
  readonly projectId: string;
  readonly sourceId: string;
}

export interface SourceWatchDependencies {
  readonly store: SourceStore;
  /** Everyone watching something right now. */
  readonly watchers: Effect.Effect<ReadonlyArray<Watcher>, AutomationError>;
  /** One read of the operation through the user's connections (connections.ts). */
  readonly read: (input: {
    readonly operation: string;
    readonly args: unknown;
    readonly connection?: string | undefined;
    readonly autoApprove: boolean;
    readonly idempotencyKey: string;
  }) => Effect.Effect<unknown, AutomationError>;
  /** Hands a change to triggers and waits. */
  readonly publish: (envelope: SourceEnvelope) => Effect.Effect<void>;
  readonly notify: (notice: AutomationNotice) => Effect.Effect<void>;
  /** A source paused after too many failed reads: runs waiting on it stop waiting with `error`. */
  readonly paused: (
    sourceId: string,
    watchers: ReadonlyArray<Watcher>,
    error: string,
  ) => Effect.Effect<void>;
  /** A source was read, so views showing these watchers' status recompute; one per automation or run. */
  readonly checked: (watchers: ReadonlyArray<Watcher>) => Effect.Effect<void>;
  /** Counts reads in flight, so the engine's drain waits for them. */
  readonly adjustBusy: (delta: number) => Effect.Effect<void>;
  readonly scope: Scope.Scope;
}

/** A source gone quiet, now watched by someone who wants it read more often than it is. */
const tooSlow = (row: Pick<SourceRow, "interval_ms">, group: Pick<Group, "everyMs">) =>
  row.interval_ms > group.everyMs * QUIET_MAX;

interface Group {
  readonly sourceId: string;
  readonly projectId: string;
  readonly watch: WorkflowSourceWatch;
  readonly everyMs: number;
  readonly watchers: ReadonlyArray<Watcher>;
}

function groupWatchers(watchers: ReadonlyArray<Watcher>): Map<string, Group> {
  const groups = new Map<string, Group & { watchers: Watcher[]; everyMs: number }>();
  for (const watcher of watchers) {
    const sourceId = sourceIdOf(watcher.projectId, watcher.watch);
    const group = groups.get(sourceId);
    if (group) {
      group.watchers.push(watcher);
      group.everyMs = Math.min(group.everyMs, everyMsOf(watcher.watch));
    } else
      groups.set(sourceId, {
        sourceId,
        projectId: watcher.projectId,
        watch: watcher.watch,
        everyMs: everyMsOf(watcher.watch),
        watchers: [watcher],
      });
  }
  return groups;
}

/** The event a change becomes. Reads are stored before their events go out, so an id never comes round twice. */
function envelopeOf(
  group: Pick<Group, "sourceId" | "projectId" | "watch">,
  change: SourceChange,
  at: string,
): SourceEnvelope {
  const event = `source.item.${change.kind}`;
  return {
    event,
    // Each read is one occurrence: a status flipping back and forth is a new change every time.
    id: `${event}:${group.sourceId}:${change.key}:${at}`,
    at,
    projectId: group.projectId,
    sourceId: group.sourceId,
    source: { operation: group.watch.operation, connection: group.watch.connection ?? null },
    key: change.key,
    item: change.item,
    ...(change.kind === "changed" ? { before: change.before, changed: change.changed } : {}),
  };
}

export const makeSourceWatches = (deps: SourceWatchDependencies) => {
  const { store } = deps;
  const reading = new Set<string>();
  /** Who watched each source at the last tick; someone new lifts a pause. */
  const seen = new Map<string, ReadonlySet<string>>();
  let lastPrune = Number.NEGATIVE_INFINITY;
  const logged = logFailure("Automation source watch failed");

  const pausedNotice = (automation: AutomationRow, error: string, at: string, sourceId: string) =>
    ({
      id: `${sourceId}/paused/${automation.automation_id}/${at}`,
      kind: "failed",
      automationId: automation.automation_id,
      runId: "",
      stepKey: "",
      title: automation.name,
      body: `${error} Signalbox stopped watching it; save the automation again to retry.`,
      importance: "high",
      at,
    }) satisfies AutomationNotice;

  /**
   * One read of a source, its diff, and its events. Reads of one source never
   * overlap, and each starts from the stored row, so a tick that listed it
   * before the last read finished can't read it twice.
   */
  const check = (sourceId: string, group: Group) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const at = DateTime.formatIso(now);
      const row = yield* store.get(sourceId);
      if (!row || row.paused_at !== null || (row.next_check_at > at && !tooSlow(row, group)))
        return false;
      const { watch } = group;
      // Executor asks before calls the owner didn't allow everything for; every watcher has to allow it.
      const autoApprove = group.watchers.every(
        (watcher) => automationDefaults(watcher.automation).runtimeMode === "full-access",
      );
      const answer = yield* deps
        .read({
          operation: watch.operation,
          args: watch.args ?? {},
          connection: watch.connection,
          autoApprove,
          idempotencyKey: `${row.source_id}/${at}`,
        })
        .pipe(
          Effect.mapError((cause) => ({
            message: errorMessage(cause),
            retryAfterMs: transientCause(cause)?.retryAfterMs,
          })),
          Effect.flatMap((value) => {
            const listed = listOf(value, watch.items);
            if (!listed.ok) return Effect.fail({ message: listed.error, retryAfterMs: undefined });
            const snapshot = snapshotOf(listed.list.slice(0, MAX_ITEMS), watch.key);
            // A key nothing has would read as an empty list forever; say so instead.
            return snapshot.length === 0 && listed.list.length > 0
              ? Effect.fail({
                  message: `None of the ${listed.list.length} items has "${watch.key}"; set key to the field that identifies an item.`,
                  retryAfterMs: undefined,
                })
              : Effect.succeed(snapshot);
          }),
          Effect.result,
        );

      if (answer._tag === "Failure") {
        const failures = row.failures + 1;
        const pause = failures >= MAX_FAILURES;
        const backoff = Math.max(
          Math.min(group.everyMs * 2 ** failures, MAX_BACKOFF_MS),
          answer.failure.retryAfterMs ?? 0,
        );
        yield* store.recordFailure({
          sourceId: row.source_id,
          failures,
          error: answer.failure.message,
          nextCheckAt: isoAt(now.epochMilliseconds + backoff),
          checkedAt: at,
          pause,
        });
        yield* Effect.logWarning("Automation source read failed", {
          sourceId: row.source_id,
          operation: watch.operation,
          failures,
        });
        if (pause) {
          const error = `Couldn't read ${watch.operation} ${MAX_FAILURES} times in a row: ${answer.failure.message}`;
          // Runs waiting on it end their wait with the error; owners of triggers hear once.
          yield* deps.paused(group.sourceId, group.watchers, error);
          const owners = new Map(
            group.watchers
              .filter((watcher) => watcher.runId === undefined)
              .map((watcher) => [watcher.automation.automation_id, watcher.automation]),
          );
          for (const automation of owners.values())
            yield* deps.notify(pausedNotice(automation, error, at, group.sourceId));
        }

        return true;
      }

      const snapshot = answer.success;
      const before = row.snapshot_json === null ? null : (fromJson(row.snapshot_json) as Snapshot);
      const changes = before === null ? [] : diffSnapshots(before, snapshot);
      // A first read or a change keeps the watchers' pace; only a source that stays the same slows down.
      const intervalMs =
        before === null || changes.length > 0
          ? group.everyMs
          : Math.min(
              Math.round(Math.max(row.interval_ms, group.everyMs) * QUIET_FACTOR),
              group.everyMs * QUIET_MAX,
            );
      yield* store.recordRead({
        sourceId: row.source_id,
        snapshot: before === null || changes.length > 0 ? toJson(snapshot) : null,
        intervalMs,
        nextCheckAt: isoAt(now.epochMilliseconds + intervalMs),
        checkedAt: at,
        changed: changes.length > 0,
      });
      for (const change of changes) yield* deps.publish(envelopeOf(group, change, at));
      return true;
    });

  /** Reads every source that's due, each in its own fiber, and starts or forgets sources as watchers come and go. */
  const tick = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const at = DateTime.formatIso(now);
    const groups = groupWatchers(yield* deps.watchers);
    const rows = new Map<string, Pick<SourceRow, "paused_at" | "next_check_at" | "interval_ms">>(
      (yield* store.schedule([...groups.keys()])).map((row) => [row.source_id, row]),
    );
    for (const group of groups.values()) {
      if (rows.has(group.sourceId)) continue;
      const row: SourceRow = {
        source_id: group.sourceId,
        project_id: group.projectId,
        watch_json: toJson(group.watch),
        snapshot_json: null,
        interval_ms: group.everyMs,
        next_check_at: at,
        last_checked_at: null,
        last_changed_at: null,
        failures: 0,
        last_error: null,
        paused_at: null,
        wanted_at: at,
        created_at: at,
      };
      yield* store.insert(row);
      rows.set(group.sourceId, row);
    }
    if (now.epochMilliseconds - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = now.epochMilliseconds;
      yield* store.wanted([...groups.keys()], at);
      yield* store.prune(isoAt(now.epochMilliseconds - FORGET_AFTER_MS));
    }

    for (const group of groups.values()) {
      const row = rows.get(group.sourceId)!;
      const ids = new Set(group.watchers.map((watcher) => watcher.id));
      const before = seen.get(group.sourceId);
      seen.set(group.sourceId, ids);
      if (row.paused_at !== null) {
        if (before && [...ids].every((id) => before.has(id))) continue;
        yield* store.resume(group.sourceId, at);
      } else if (row.next_check_at > at && !tooSlow(row, group)) continue;
      if (reading.has(group.sourceId)) continue;
      reading.add(group.sourceId);
      yield* deps.adjustBusy(1);
      yield* check(group.sourceId, group).pipe(
        Effect.flatMap((read) => (read ? deps.checked(group.watchers) : Effect.void)),
        logged,
        Effect.ensuring(
          Effect.sync(() => reading.delete(group.sourceId)).pipe(
            Effect.andThen(deps.adjustBusy(-1)),
          ),
        ),
        Effect.forkIn(deps.scope),
      );
    }
    for (const sourceId of seen.keys()) if (!groups.has(sourceId)) seen.delete(sourceId);
  });

  /** What each of these watches reads and how that's going, for the run view and automation page. */
  const statusOf = (projectId: string, watches: ReadonlyArray<WorkflowSourceWatch>) =>
    Effect.gen(function* () {
      const byId = new Map(watches.map((watch) => [sourceIdOf(projectId, watch), watch]));
      const rows = new Map(
        (yield* store.statuses([...byId.keys()])).map((row) => [row.source_id, row]),
      );
      return [...byId].map(([sourceId, watch]): AutomationSourceStatus => {
        const row = rows.get(sourceId);
        return {
          sourceId,
          operation: watch.operation,
          connection: watch.connection ?? null,
          status: !row
            ? "starting"
            : row.paused_at
              ? "paused"
              : row.failures > 0
                ? "failing"
                : row.read
                  ? "watching"
                  : "starting",
          lastCheckedAt: row?.last_checked_at ?? null,
          lastChangedAt: row?.last_changed_at ?? null,
          nextCheckAt: row && row.paused_at === null ? row.next_check_at : null,
          error: row?.last_error ?? null,
        };
      });
    });

  return { tick: tick.pipe(logged), statusOf };
};

export type SourceWatches = ReturnType<typeof makeSourceWatches>;
