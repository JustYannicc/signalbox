import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { AutomationThreads, type AutomationThreadsShape } from "./host.ts";
import { agentResult } from "./steps.ts";

const threadId = "thread-sync";
const run = { id: "run-1", status: "completed" };

/** A thread as the cloud keeps it: pull requests only in `pullRequests`, no legacy fields. */
const threads = (pullRequests: ReadonlyArray<unknown>) =>
  ({
    getThreadShell: () =>
      Effect.succeed({
        id: threadId,
        deletedAt: null,
        branch: "signalbox/0000sync",
        worktreePath: "/drives/d/threads/thread-sync",
        pullRequests,
      } as never),
    getThreadRecords: () => Effect.succeed({ runs: [run], messages: [], turnItems: [] } as never),
  }) as unknown as AutomationThreadsShape;

const link = (number: number, linkedAt: string) => ({
  host: "github.com",
  repository: "justyannicc/signalbox",
  number,
  url: `https://github.com/JustYannicc/signalbox/pull/${number}`,
  source: "agent",
  linkedAt,
  snapshot: null,
  stack: null,
});

describe("an agent step's result", () => {
  it.effect("names the pull request the agent opened, kept as a thread link (#5)", () =>
    Effect.gen(function* () {
      const result = yield* agentResult(threadId, run.id).pipe(
        Effect.provideService(AutomationThreads, threads([link(729, "2026-10-16T20:27:00Z")])),
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          branch: "signalbox/0000sync",
          pullRequest: { number: 729, url: "https://github.com/JustYannicc/signalbox/pull/729" },
        },
      });
    }),
  );

  it.effect("has no pull request when the thread links none", () =>
    Effect.gen(function* () {
      const result = yield* agentResult(threadId, run.id).pipe(
        Effect.provideService(AutomationThreads, threads([])),
      );
      expect(result).toMatchObject({ ok: true, value: { pullRequest: null } });
    }),
  );
});
