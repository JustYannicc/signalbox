import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
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
  command: OrchestrationV2Command,
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
});
