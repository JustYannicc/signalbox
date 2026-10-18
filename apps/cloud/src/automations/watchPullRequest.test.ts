import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";

import { makePullRequestThread, threadId } from "./pullRequestThreadTesting.ts";
import * as CloudAutomations from "./CloudAutomations.ts";

describe("cloud automations watch a cloud thread's pull request", () => {
  it.effect("wakes the thread when CI finishes on the pull request it opened (#397)", () => {
    const { cloud, github, open, tool, messages, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        const linked = (yield* cloud.threadEvents(threadId)).at(-1);
        if (linked?.type !== "thread.pull-request-synced") return expect.unreachable();
        expect(linked.payload.pullRequests).toEqual([
          expect.objectContaining({
            host: "github.test",
            repository: "owner/repo",
            number: 1,
            url: "https://github.test/owner/repo/pull/1",
            source: "created",
            snapshot: null,
          }),
        ]);

        // The first read: open, checks running.
        github.update(1, {
          checks: [{ name: "test", status: "IN_PROGRESS", conclusion: null }],
        });
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;

        // The agent asks Signalbox to watch it, from its machine, by a URL cased the way it
        // was typed: links (and their pr.* events) use the lowercased key.
        const watched = yield* tool("watch_pull_request", {
          url: "https://github.test/Owner/Repo/pull/1",
        });
        expect(watched).toMatchObject({ number: 1, repository: "owner/repo", watching: true });
        yield* cloud.settle;

        // CI passes; the next sync's event reaches the watch, which wakes the agent.
        github.update(1, {
          checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
        });
        yield* cloud.forgetPullRequestPolls(threadId);
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;
        expect(
          (yield* messages(rpc)).some((text) =>
            text.startsWith(
              "Checks passed on pull request #1 (https://github.test/owner/repo/pull/1).",
            ),
          ),
        ).toBe(true);
      }),
    );
  });

  it.effect(
    "replays one durable watch command, exposes unwatch, and ignores stale watch state",
    () => {
      const { cloud, open, run } = makePullRequestThread();
      return run(
        Effect.gen(function* () {
          const { rpc } = yield* open;
          yield* cloud.settle;

          const command = {
            type: "thread.pull-request.watch",
            commandId: CommandId.make("watch-once"),
            threadId,
            host: "github.test",
            repository: "owner/repo",
            number: 1,
            watching: true,
          } as const;
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
          yield* cloud.settle;

          const watches = yield* cloud.inUser(
            "user_1",
            WorkflowEngine.WorkflowEngine.use((engine) => engine.listWaits(threadId)),
          );
          expect(watches.filter((wait) => wait.automation === "Watch pull request")).toHaveLength(
            1,
          );
          const watchEvent = (yield* cloud.threadEvents(threadId)).find(
            (
              event,
            ): event is Extract<
              OrchestrationV2DomainEvent,
              { type: "thread.pull-request-synced" }
            > =>
              event.type === "thread.pull-request-synced" &&
              event.payload.pullRequests?.some(
                (link) => link.number === 1 && link.watch !== undefined,
              ) === true,
          );
          if (watchEvent === undefined) return expect.unreachable();

          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.pull-request.watch",
            commandId: CommandId.make("unwatch"),
            threadId,
            host: "github.test",
            repository: "owner/repo",
            number: 1,
            watching: false,
          });
          yield* cloud.settle;
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId,
          });
          expect(
            projection.thread.pullRequests?.find((link) => link.number === 1)?.watch,
          ).toBeUndefined();
          const afterUnwatch = yield* cloud.inUser(
            "user_1",
            WorkflowEngine.WorkflowEngine.use((engine) => engine.listWaits(threadId)),
          );
          expect(afterUnwatch.filter((wait) => wait.automation === "Watch pull request")).toEqual(
            [],
          );

          // A newly delivered event can still carry old state. Reconciliation reads the current thread.
          yield* cloud.inUser(
            "user_1",
            CloudAutomations.CloudAutomations.use((automations) =>
              automations.threadEvents({
                threadId,
                events: [{ sequence: 10_000, event: watchEvent }],
              }),
            ),
          );
          const afterStaleDelivery = yield* cloud.inUser(
            "user_1",
            WorkflowEngine.WorkflowEngine.use((engine) => engine.listWaits(threadId)),
          );
          expect(
            afterStaleDelivery.filter((wait) => wait.automation === "Watch pull request"),
          ).toEqual([]);
        }),
      );
    },
  );
});
