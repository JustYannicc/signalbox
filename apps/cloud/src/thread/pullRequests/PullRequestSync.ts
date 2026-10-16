import {
  CommandId,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";

import { GitHub } from "../../github/GitHub.ts";
import { pullRequestSnapshot } from "../../github/GitHubPullRequests.ts";
import { UserDirectory } from "../../user/UserDirectory.ts";
import { isLiveRun } from "../runLifecycle.ts";
import { awaitsHandoff, harnessRun } from "../runner/runnerTurn.ts";
import { type Actor, ThreadEngine } from "../ThreadEngine.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { snapshotFieldsEqual } from "./pullRequestLinks.ts";
import * as PullRequestPollsStore from "./PullRequestPolls.ts";
import { type PullRequestPoll, PullRequestPolls } from "./PullRequestPolls.ts";

/**
 * Keeps a cloud thread's linked pull requests' host state current, from the
 * thread object's alarm: the cloud's counterpart of upstream's
 * `PullRequestSyncReactor`. Each due link is read from GitHub with the
 * owner's token, asked of their own object (machines never hold one), and a
 * changed snapshot is dispatched as `thread.pull-request-link.sync`, so it
 * commits and streams like any command. An unchanged one sends nothing.
 *
 * Cadence: an open pull request is read every minute while the thread or the
 * pull request changed in the last ten minutes or a turn runs, every five
 * otherwise. A merged one is never read again; a closed one (it can reopen)
 * once more after the thread next changes. A rate limit pauses every read of
 * the thread until the time GitHub gave, since it limits the owner's token.
 *
 * A turn waiting to start reads every link not read since it was asked for
 * first, so its machine knows whether the thread's pull request merged and
 * takes in the new `main` (#495): the object holds the turn back until then,
 * for `TURN_HOLD_MS` at most.
 */

export const FAST_POLL_MS = 60_000;
export const SLOW_POLL_MS = 5 * 60_000;
export const RECENT_MS = 10 * 60_000;
/** The longest a turn waits for its reads: a sync that keeps failing never stalls it. */
export const TURN_HOLD_MS = 15_000;

const pullRequestReads = Metric.counter("signalbox_cloud_pull_request_reads_total", {
  description: "Linked pull request reads from a thread object's alarm, by outcome.",
});

type Outcome = "changed" | "unchanged" | "not_found" | "rate_limited" | "failed" | "not_connected";

const ms = (at: DateTime.Utc | string | null | undefined) =>
  at === null || at === undefined
    ? 0
    : typeof at === "string"
      ? Date.parse(at) || 0
      : DateTime.toEpochMillis(at);

/**
 * When someone last did something on the thread: a turn, a message, a visit,
 * a change to the thread itself. Pull request syncs aren't activity, so a
 * sync never makes the next one sooner.
 */
const lastActivity = (projection: OrchestrationV2ThreadProjection) =>
  Math.max(
    ms(projection.thread.updatedAt),
    ms(projection.thread.lastVisitedAt),
    ...projection.runs.map((run) => Math.max(ms(run.requestedAt), ms(run.completedAt))),
    ...projection.messages.map((message) => ms(message.updatedAt)),
  );

/** One link and when it is next due: `at <= now` means now, null never. */
interface Due {
  readonly link: ThreadPullRequestLink;
  readonly key: string;
  readonly at: number | null;
}

/**
 * When each GitHub link on the thread is next due, given when each was last
 * read. Links on other hosts aren't listed. Pure.
 */
export function pullRequestSchedule(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly polls: ReadonlyMap<string, PullRequestPoll>;
  readonly host: string;
  readonly now: number;
}): ReadonlyArray<Due> {
  const { projection, polls, now } = input;
  const activeAt = lastActivity(projection);
  const live = projection.runs.some(isLiveRun);
  const starting = harnessRun(projection);
  const turnAskedAt =
    starting !== undefined && awaitsHandoff(starting) ? ms(starting.requestedAt) : null;
  // A rate limit is the owner's token's, so it pauses every link.
  const pausedUntil = Math.max(0, ...[...polls.values()].map((poll) => poll.retryAt ?? 0));
  return visibleThreadPullRequests(projection.thread.pullRequests ?? []).flatMap((link) => {
    if (normalizeThreadPullRequestKey(link).host !== input.host) return [];
    const key = threadPullRequestKeyOf(link);
    const polledAt = polls.get(key)?.polledAt ?? null;
    const at = (() => {
      const snapshot = link.snapshot;
      if (snapshot?.state === "merged") return null;
      if (polledAt === null) return now;
      if (turnAskedAt !== null && polledAt < turnAskedAt) return now;
      if (snapshot?.state === "closed") {
        return activeAt > polledAt ? polledAt + FAST_POLL_MS : null;
      }
      // Never read yet (GitHub unreachable, not connected, gone) paces like a quiet one.
      const recent = live || now - Math.max(activeAt, ms(snapshot?.updatedAt)) < RECENT_MS;
      return polledAt + (recent ? FAST_POLL_MS : SLOW_POLL_MS);
    })();
    return [{ link, key, at: at === null ? null : Math.max(at, pausedUntil) }];
  });
}

const nextAt = (schedule: ReadonlyArray<Due>) => {
  const times = schedule.flatMap((entry) => (entry.at === null ? [] : [entry.at]));
  return times.length === 0 ? null : Math.min(...times);
};

export class PullRequestSync extends Context.Service<
  PullRequestSync,
  {
    /** Reads every due link and dispatches what changed. Returns when one is due next; null: none. */
    readonly sync: Effect.Effect<number | null>;
    /** When a link is due next, reading nothing from GitHub. */
    readonly dueAt: Effect.Effect<number | null>;
    /** Whether a turn waiting to start waits for reads due now; `sync` makes them. Never fails. */
    readonly holdsTurn: Effect.Effect<boolean>;
  }
>()("@signalbox/cloud/thread/pullRequests/PullRequestSync") {}

const make = Effect.gen(function* () {
  const engine = yield* ThreadEngine;
  const store = yield* ThreadStore;
  const polls = yield* PullRequestPolls;
  const users = yield* UserDirectory;
  const github = yield* GitHub;
  const crypto = yield* Crypto.Crypto;
  const host = github.api.host;

  /** The thread when it has links to schedule, with its polls; null otherwise. */
  const linked = Effect.gen(function* () {
    const projection = yield* engine.projection;
    // A thread with no links has no polls to read.
    if (projection === null || (projection.thread.pullRequests ?? []).length === 0) return null;
    return { projection, polls: yield* Effect.orDie(polls.all) };
  });

  const dueAt: PullRequestSync["Service"]["dueAt"] = Effect.gen(function* () {
    const current = yield* linked;
    if (current === null) return null;
    const now = yield* Clock.currentTimeMillis;
    return nextAt(pullRequestSchedule({ ...current, host, now }));
  });

  const holdsTurn: PullRequestSync["Service"]["holdsTurn"] = Effect.gen(function* () {
    const projection = yield* engine.projection;
    const run = projection === null ? undefined : harnessRun(projection);
    if (projection === null || run === undefined || !awaitsHandoff(run)) return false;
    if ((projection.thread.pullRequests ?? []).length === 0) return false;
    const now = yield* Clock.currentTimeMillis;
    if (now >= ms(run.requestedAt) + TURN_HOLD_MS) return false;
    const at = nextAt(
      pullRequestSchedule({ projection, polls: yield* Effect.orDie(polls.all), host, now }),
    );
    return at !== null && at <= now;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning("checking pull request reads failed", Cause.pretty(cause)),
        false,
      ),
    ),
  );

  const counted = (outcome: Outcome) =>
    Metric.update(Metric.withAttributes(pullRequestReads, { outcome }), 1);

  /** Reads one link and dispatches its snapshot when it changed. */
  const syncLink = (link: ThreadPullRequestLink, token: string, owner: Actor, threadId: ThreadId) =>
    Effect.gen(function* () {
      const read = yield* pullRequestSnapshot(github.api, token, link.repository, link.number).pipe(
        Effect.result,
      );
      if (read._tag === "Failure") {
        const error = read.failure;
        if (error.retryAt !== undefined) {
          yield* counted("rate_limited");
          return { retryAt: error.retryAt };
        }
        yield* counted("failed");
        yield* Effect.logWarning("pull request read failed", {
          operation: error.operation,
          status: error.status,
        });
        return { retryAt: null };
      }
      const fields = read.success;
      if (fields === null) {
        yield* counted("not_found");
        return { retryAt: null };
      }
      if (link.snapshot !== null && snapshotFieldsEqual(link.snapshot, fields)) {
        yield* counted("unchanged");
        return { retryAt: null };
      }
      const now = yield* Clock.currentTimeMillis;
      const uuid = yield* Effect.orDie(crypto.randomUUIDv4());
      yield* engine
        .dispatch(
          owner,
          {
            type: "thread.pull-request-link.sync",
            commandId: CommandId.make(`cloud:pr-sync:${threadId}:${uuid}`),
            threadId,
            host: normalizeThreadPullRequestKey(link).host,
            repository: link.repository,
            number: link.number,
            snapshot: { ...fields, syncedAt: DateTime.formatIso(DateTime.makeUnsafe(now)) },
            stack: link.stack,
          },
          { place: null, pools: null },
        )
        .pipe(
          Effect.catchTags({
            ThreadNotFoundError: () => Effect.void,
            ThreadCommandRejectedError: (error) =>
              Effect.logWarning("pull request sync rejected", { reason: error.reason }),
          }),
        );
      yield* counted("changed");
      return { retryAt: null };
    });

  const sync: PullRequestSync["Service"]["sync"] = Effect.gen(function* () {
    const current = yield* linked;
    if (current === null) return null;
    const now = yield* Clock.currentTimeMillis;
    const entries = pullRequestSchedule({ ...current, host, now });
    const due = entries.filter((entry) => entry.at !== null && entry.at <= now);
    if (due.length === 0) return nextAt(entries);
    const owner = yield* Effect.orDie(store.owner);
    if (owner === null) return null;
    const threadId = current.projection.thread.id;
    // Who and where, never what (#284): ids only.
    yield* Effect.annotateCurrentSpan({
      "person.id": owner.userId,
      "folder.id": owner.driveId ?? "my-drive",
      "thread.id": threadId,
      "pull_requests.due": due.length,
    });
    // Only links still on the thread keep a poll; the others' stay as they were.
    const recorded = new Map(
      [...current.polls].filter(([key]) => entries.some((entry) => entry.key === key)),
    );
    // Suspended: it saves `recorded` as the reads below left it.
    const save = Effect.suspend(() => Effect.orDie(polls.replace([...recorded.values()])));
    yield* Effect.gen(function* () {
      const token = yield* users
        .forUser(owner.userId)
        .githubAccessToken()
        .pipe(
          Effect.catch((cause) =>
            Effect.as(
              Effect.logWarning("GitHub token unavailable for pull request sync", { cause }),
              null,
            ),
          ),
        );
      // The owner, within the thread's own context, which is all a sync needs to see it.
      const actor = { userId: owner.userId, contextIds: [owner.contextId] };
      for (const { link, key } of due) {
        if (token === null) {
          yield* counted("not_connected");
          recorded.set(key, { key, polledAt: now, retryAt: null });
          continue;
        }
        const { retryAt } = yield* syncLink(link, token, actor, threadId);
        recorded.set(key, { key, polledAt: now, retryAt });
        // The rest wait out the pause with it.
        if (retryAt !== null) break;
      }
      // Saved even when something above failed, so a retry doesn't read them all again.
    }).pipe(Effect.ensuring(save));
    const after = yield* engine.projection;
    return after === null
      ? null
      : nextAt(pullRequestSchedule({ projection: after, polls: recorded, host, now }));
  }).pipe(Effect.withSpan("PullRequestSync.sync"));

  return PullRequestSync.of({ sync, dueAt, holdsTurn });
});

/** In a thread's object: needs its engine and store, the owner's object, and GitHub. */
export const layer = Layer.effect(PullRequestSync, make).pipe(
  Layer.provideMerge(PullRequestPollsStore.layer),
);
