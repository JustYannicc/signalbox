import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ThreadPullRequestWatchSyncCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { scriptedModelSelection } from "../scriptedProvider.ts";
import { decide } from "../threadDecider.ts";
import { applyEvents, threadShellFromProjection } from "../threadProjection.ts";
import { FAST_POLL_MS, pullRequestSchedule, RECENT_MS, SLOW_POLL_MS } from "./PullRequestSync.ts";

const threadId = ThreadId.make("thread-1");
const at = (iso: string) => ({ now: DateTime.makeUnsafe(iso) });
const T0 = "2026-10-15T10:00:00.000Z";
const key = { host: "github.com", repository: "owner/repo", number: 7 } as const;
const url = "https://github.com/owner/repo/pull/7";

const created = (): OrchestrationV2ThreadProjection => {
  const decision = decide(
    null,
    {
      type: "thread.create",
      commandId: CommandId.make("create"),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId: ProjectId.make("project"),
      title: "Ship it",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "signalbox/1",
      worktreePath: null,
    },
    at(T0),
  );
  if (decision._tag !== "accepted") throw new Error(decision.message);
  return applyEvents(null, decision.events)!;
};

/** Decides `command` and folds what it decided; the events too. */
const run = (
  projection: OrchestrationV2ThreadProjection,
  command: OrchestrationV2Command | ThreadPullRequestWatchSyncCommand,
  iso = "2026-10-15T10:01:00.000Z",
) => {
  const decision = decide(projection, command, at(iso));
  if (decision._tag !== "accepted") throw new Error(decision.message);
  return {
    events: decision.events as ReadonlyArray<OrchestrationV2DomainEvent>,
    projection: applyEvents(projection, decision.events)!,
  };
};

const link = (source: "created" | "manual" | "agent" = "created"): OrchestrationV2Command => ({
  type: "thread.pull-request.link",
  commandId: CommandId.make(`link-${source}`),
  threadId,
  ...key,
  repository: "Owner/Repo",
  url,
  source,
});

const snapshot = (change: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot => ({
  state: "open",
  title: "Ship it",
  headBranch: "signalbox/1",
  baseBranch: "main",
  isDraft: false,
  updatedAt: "2026-10-15T10:00:00Z",
  syncedAt: "2026-10-15T10:02:00.000Z",
  checksState: "pending",
  mergeability: "mergeable",
  reviewDecision: null,
  ...change,
});

const sync = (
  value: ThreadPullRequestSnapshot,
): Extract<OrchestrationV2Command, { readonly type: "thread.pull-request-link.sync" }> => ({
  type: "thread.pull-request-link.sync",
  commandId: CommandId.make(`sync-${value.syncedAt}`),
  threadId,
  ...key,
  snapshot: value,
  stack: null,
});

const watch = (
  watching: boolean,
  commandId: string,
): Extract<OrchestrationV2Command, { readonly type: "thread.pull-request.watch" }> => ({
  type: "thread.pull-request.watch",
  commandId: CommandId.make(commandId),
  threadId,
  ...key,
  watching,
});

const stopAutomationWatch = (
  startedAt: string,
  commandId = `stop-automation-watch-${startedAt}`,
): ThreadPullRequestWatchSyncCommand => ({
  type: "thread.pull-request-watch.sync",
  commandId: CommandId.make(commandId),
  threadId,
  ...key,
  startedAt,
  watch: null,
});

describe("cloud pull request links", () => {
  it("links a pull request once, under its normalized key, and shows it on the sidebar row", () => {
    const linked = run(created(), link());
    expect(linked.events.map((event) => event.type)).toEqual(["thread.pull-request-synced"]);
    expect(linked.projection.thread.pullRequests).toEqual([
      {
        host: "github.com",
        repository: "owner/repo",
        number: 7,
        url,
        source: "created",
        linkedAt: "2026-10-15T10:01:00.000Z",
        snapshot: null,
        stack: null,
      },
    ]);
    expect(threadShellFromProjection(linked.projection).pullRequests).toHaveLength(1);
    // A link the thread has changes nothing, whoever links it again.
    expect(run(linked.projection, link("agent")).events).toEqual([]);
  });

  it("emits the synced snapshot as thread.pull-request-synced, and nothing when it didn't change", () => {
    const linked = run(created(), link()).projection;
    const first = run(linked, sync(snapshot()), "2026-10-15T10:02:00.000Z");
    expect(first.events).toHaveLength(1);
    const [event] = first.events;
    if (event?.type !== "thread.pull-request-synced") throw new Error("expected a sync event");
    expect(event.payload.pullRequests?.[0]?.snapshot).toEqual(snapshot());
    // A sync is the host's news, not activity on the thread.
    expect(event.payload.updatedAt).toEqual(linked.thread.updatedAt);

    // Read again a minute later: only syncedAt moved.
    expect(
      run(first.projection, sync(snapshot({ syncedAt: "2026-10-15T10:03:00.000Z" }))).events,
    ).toEqual([]);
    const passed = run(
      first.projection,
      sync(snapshot({ checksState: "passing", syncedAt: "2026-10-15T10:04:00.000Z" })),
    );
    expect(passed.projection.thread.pullRequests?.[0]?.snapshot?.checksState).toBe("passing");

    // A pull request the thread doesn't link isn't synced onto it.
    expect(run(created(), sync(snapshot())).events).toEqual([]);
  });

  it("unlinks, and keeps a stack member as a tombstone so a stack sync won't re-add it", () => {
    const linked = run(created(), link()).projection;
    const unlink: OrchestrationV2Command = {
      type: "thread.pull-request.unlink",
      commandId: CommandId.make("unlink"),
      threadId,
      ...key,
    };
    expect(run(linked, unlink).projection.thread.pullRequests).toEqual([]);
    expect(run(created(), unlink).events).toEqual([]);

    const stacked = run(linked, {
      ...sync(snapshot()),
      stack: {
        kind: "native",
        id: "stack-1",
        number: 1,
        url: "https://github.com/owner/repo/stacks/1",
        base: "main",
        layers: [{ number: 7, headBranch: "signalbox/1", state: "open" }],
      },
    }).projection;
    const dismissed = run(stacked, unlink).projection;
    expect(dismissed.thread.pullRequests?.[0]?.source).toBe("stack-dismissed");
    expect(threadShellFromProjection(dismissed).pullRequests?.[0]?.source).toBe("stack-dismissed");
  });

  it("records a watch on the thread, dedupes a repeated watch, and visibly clears it on unwatch", () => {
    const linked = run(created(), link()).projection;
    const started = run(linked, watch(true, "watch"), "2026-10-15T10:03:00.000Z");
    expect(started.events.map((event) => event.type)).toEqual(["thread.pull-request-synced"]);
    expect(started.projection.thread.pullRequests?.[0]).toMatchObject({
      number: 7,
      watch: {
        startedAt: "2026-10-15T10:03:00.000Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-10-15T10:03:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      },
    });

    expect(run(started.projection, watch(true, "watch-again")).events).toEqual([]);

    const stopped = run(started.projection, watch(false, "unwatch"));
    expect(stopped.events.map((event) => event.type)).toEqual(["thread.pull-request-synced"]);
    expect(stopped.projection.thread.pullRequests?.[0]).not.toHaveProperty("watch");
    expect(run(stopped.projection, watch(false, "unwatch-again")).events).toEqual([]);
  });

  it("clears only the automation watch generation that ended", () => {
    const linked = run(created(), link()).projection;
    const first = run(linked, watch(true, "watch-first"), "2026-10-15T10:03:00.000Z");
    const firstStartedAt = first.projection.thread.pullRequests?.[0]?.watch?.startedAt;
    if (firstStartedAt === undefined) throw new Error("The first watch wasn't recorded.");

    const cleared = run(first.projection, stopAutomationWatch(firstStartedAt));
    expect(cleared.events.map((event) => event.type)).toEqual(["thread.pull-request-synced"]);
    expect(cleared.projection.thread.pullRequests?.[0]).not.toHaveProperty("watch");

    const second = run(cleared.projection, watch(true, "watch-second"), "2026-10-15T10:04:00.000Z");
    const secondStartedAt = second.projection.thread.pullRequests?.[0]?.watch?.startedAt;
    expect(secondStartedAt).not.toBe(firstStartedAt);
    expect(run(second.projection, stopAutomationWatch(firstStartedAt)).events).toEqual([]);
    expect(second.projection.thread.pullRequests?.[0]?.watch?.startedAt).toBe(secondStartedAt);

    expect(
      run(second.projection, stopAutomationWatch(secondStartedAt!)).projection.thread
        .pullRequests?.[0],
    ).not.toHaveProperty("watch");
  });

  it("rejects automation watch syncs other than a guarded stop", () => {
    const linked = run(created(), link()).projection;
    const started = run(linked, watch(true, "watch-for-rejected-sync"));
    const startedWatch = started.projection.thread.pullRequests?.[0]?.watch;
    if (startedWatch === undefined) throw new Error("The test watch wasn't recorded.");

    expect(
      decide(
        started.projection,
        { ...stopAutomationWatch(startedWatch.startedAt), watch: startedWatch },
        at("2026-10-15T10:03:00.000Z"),
      ),
    ).toMatchObject({
      _tag: "rejected",
      message: "Cloud only supports stopping an ended pull request watch.",
    });
  });

  it("can link and watch in one command", () => {
    const command: OrchestrationV2Command = {
      ...watch(true, "watch-new"),
      link: { url, source: "manual" },
    };
    const started = run(created(), command);
    expect(started.projection.thread.pullRequests).toHaveLength(1);
    expect(started.projection.thread.pullRequests?.[0]).toMatchObject({
      url,
      source: "manual",
      watch: { passed: false, wakes: 0 },
    });
  });

  it("requires an available linked pull request for a new watch", () => {
    expect(decide(created(), watch(true, "watch-unlinked"), at(T0))).toMatchObject({
      _tag: "rejected",
      message: "Link the pull request to this thread before watching it.",
    });

    const linked = run(created(), link()).projection;
    const archived = {
      ...linked,
      thread: { ...linked.thread, archivedAt: DateTime.makeUnsafe(T0) },
    };
    expect(decide(archived, watch(true, "watch-archived"), at(T0))).toMatchObject({
      _tag: "rejected",
      message: "An archived thread can't watch pull requests.",
    });
  });
});

describe("pullRequestSchedule", () => {
  const now = Date.parse("2026-10-15T12:00:00.000Z");
  /** The thread with its link synced to `value`, last active at `activeAt`. */
  const withSnapshot = (value: ThreadPullRequestSnapshot | null, activeAt: number) => {
    const linked = run(created(), link()).projection;
    const synced = value === null ? linked : run(linked, sync(value)).projection;
    return { ...synced, thread: { ...synced.thread, updatedAt: DateTime.makeUnsafe(activeAt) } };
  };
  const polled = (polledAt: number, retryAt: number | null = null) =>
    new Map([["github.com/owner/repo#7", { key: "github.com/owner/repo#7", polledAt, retryAt }]]);
  const dueAt = (
    projection: OrchestrationV2ThreadProjection,
    polls: ReturnType<typeof polled> = new Map(),
    host = "github.com",
  ) => pullRequestSchedule({ projection, polls, host, now }).map((entry) => entry.at);

  it("reads a new link at once, and only GitHub's", () => {
    expect(dueAt(withSnapshot(null, now))).toEqual([now]);
    expect(dueAt(withSnapshot(null, now), new Map(), "gitlab.com")).toEqual([]);
  });

  it("reads an open pull request every minute while something changed lately, then every five", () => {
    const quiet = now - RECENT_MS - 1;
    const pr = (updatedAt: string) => snapshot({ updatedAt, syncedAt: updatedAt });
    // The thread changed a minute ago.
    expect(dueAt(withSnapshot(pr("2026-10-15T09:00:00Z"), now - 60_000), polled(now))).toEqual([
      now + FAST_POLL_MS,
    ]);
    // The pull request changed on GitHub a minute ago.
    expect(dueAt(withSnapshot(pr("2026-10-15T11:59:00Z"), quiet), polled(now))).toEqual([
      now + FAST_POLL_MS,
    ]);
    // Nothing changed for over ten minutes.
    expect(dueAt(withSnapshot(pr("2026-10-15T09:00:00Z"), quiet), polled(now))).toEqual([
      now + SLOW_POLL_MS,
    ]);
  });

  it("stops for merged pull requests, and reads a closed one again only after the thread changes", () => {
    expect(dueAt(withSnapshot(snapshot({ state: "merged" }), now), polled(now - 1))).toEqual([
      null,
    ]);
    // Never read since linking, a merged one stays unread too: it is what the snapshot says.
    expect(dueAt(withSnapshot(snapshot({ state: "merged" }), now))).toEqual([null]);
    const closed = snapshot({ state: "closed" });
    expect(dueAt(withSnapshot(closed, now - 120_000), polled(now - 60_000))).toEqual([null]);
    expect(dueAt(withSnapshot(closed, now - 30_000), polled(now - 60_000))).toEqual([now]);
    // Its own sync is news from GitHub, not someone working on the thread.
    const linked = run(created(), link(), "2026-10-15T11:00:00.000Z").projection;
    const synced = run(linked, sync(closed), "2026-10-15T11:59:30.000Z").projection;
    expect(dueAt(synced, polled(now - 60_000))).toEqual([null]);
  });

  it("waits for GitHub's rate limit, on every link: it limits the owner's token", () => {
    expect(dueAt(withSnapshot(snapshot(), now), polled(now - FAST_POLL_MS, now + 120_000))).toEqual(
      [now + 120_000],
    );
    const otherPaused = new Map([
      ...polled(now - FAST_POLL_MS),
      [
        "github.com/owner/other#1",
        { key: "github.com/owner/other#1", polledAt: now, retryAt: now + 90_000 },
      ],
    ]);
    expect(dueAt(withSnapshot(snapshot(), now), otherPaused)).toEqual([now + 90_000]);
  });

  it("reads first when a turn waits to start, so its machine knows whether it merged (#495)", () => {
    const quiet = withSnapshot(
      snapshot({ updatedAt: "2026-10-15T09:00:00Z" }),
      now - RECENT_MS - 1,
    );
    const askedAt = now - 5_000;
    const withRun = (status: OrchestrationV2Run["status"]) => ({
      ...quiet,
      runs: [
        {
          id: RunId.make("run-1"),
          ordinal: 1,
          status,
          providerInstanceId: ProviderInstanceId.make("codex"),
          requestedAt: DateTime.makeUnsafe(askedAt),
          completedAt: null,
        } as unknown as OrchestrationV2Run,
      ],
    });
    // Last read before the turn was asked for: now.
    expect(dueAt(withRun("starting"), polled(askedAt - 1_000))).toEqual([now]);
    // Read since: its usual pace.
    expect(dueAt(withRun("starting"), polled(askedAt + 1_000))).toEqual([
      askedAt + 1_000 + FAST_POLL_MS,
    ]);
    // Once the turn runs, its machine has had what it needed.
    expect(dueAt(withRun("running"), polled(askedAt - 1_000))).toEqual([
      askedAt - 1_000 + FAST_POLL_MS,
    ]);
    // A merged one stays unread.
    expect(
      dueAt(
        { ...withRun("starting"), thread: withSnapshot(snapshot({ state: "merged" }), now).thread },
        polled(askedAt - 1_000),
      ),
    ).toEqual([null]);
  });
});
