import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { Remark } from "@signalbox/automations/events/pullRequestDetails";
import { WorkflowEngine } from "@signalbox/automations/WorkflowEngine";
import {
  DEFAULTS,
  fakeThreads,
  fakeTools,
  monitorsOf,
  pullRequestSynced,
  receiveCallback,
  threadEvent,
  withEngine,
} from "./WorkflowEngine.testkit.ts";

const access = { builtInDefaults: DEFAULTS };
const PR_URL = "https://github.com/acme/app/pull/12";

/** The messages the waits sent each thread, in order. */
const sent = (tools: ReturnType<typeof fakeTools>) =>
  tools.calls
    .filter((call) => call.tool === "t3_thread_send")
    .map((call) => call.args as { threadId: string; message: string; mode: string });

/** A request to a callback link's path, as upstream's webhook route hands it over. */
const callbackRequest = (path: string, body: string, token?: string) => {
  const [hookId, pathToken] = path.split("/").slice(-2);
  return {
    hookId: hookId!,
    token: token ?? pathToken!,
    method: "POST",
    path,
    query: "",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(body),
    bodyText: body,
  };
};

const settle = (engine: WorkflowEngine["Service"]) =>
  Effect.gen(function* () {
    yield* engine.tick;
    yield* engine.drain;
  });

it.effect(
  "wait_for on an event wakes the thread once, and the thread shows the wait meanwhile",
  () => {
    const threads = fakeThreads();
    const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
    return withEngine(
      { threads },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        yield* engine.registerBuiltinTools(tools.handler);
        const started = yield* engine.startWait(
          {
            threadId: "thread-9",
            until: "checks on #12 to fail",
            on: "pr.checks.failed",
            where: { number: 12 },
            message: "Then fix them.",
          },
          access,
        );
        expect(started.callback).toBeNull();
        yield* engine.drain;
        expect(monitorsOf("thread-9").map((task) => task.description)).toEqual([
          "Waiting for checks on #12 to fail",
        ]);
        expect(yield* engine.listWaits("thread-9")).toMatchObject([
          {
            waitId: started.waitId,
            automation: "Wait for",
            label: "Waiting for checks on #12 to fail",
          },
        ]);

        // The event's name is computed from the input: it collects once the step waits.
        yield* threads.emit(
          pullRequestSynced("thread-9", { state: "open", checksState: "pending" }),
        );
        yield* threads.emit(
          pullRequestSynced("thread-9", { state: "open", checksState: "failing" }),
        );
        yield* engine.drain;
        yield* threads.emit(
          pullRequestSynced("thread-9", { state: "open", checksState: "passing" }),
        );
        yield* threads.emit(
          pullRequestSynced("thread-9", { state: "open", checksState: "failing" }),
        );
        yield* engine.drain;

        const messages = sent(tools);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ threadId: "thread-9", mode: "queue" });
        expect(messages[0]!.message).toContain("You were waiting for checks on #12 to fail.");
        expect(messages[0]!.message).toContain("pr.checks.failed happened");
        expect(messages[0]!.message).toContain("Then fix them.");
        expect((yield* engine.getRun(started.waitId)).run.status).toBe("succeeded");
        expect(monitorsOf("thread-9").map((task) => task.description)).toEqual([]);
        expect(yield* engine.listWaits("thread-9")).toEqual([]);
      }),
    );
  },
);

it.effect("a callback link wakes the thread with what was posted, and only while it waits", () => {
  const threads = fakeThreads();
  const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const started = yield* engine.startWait(
        { threadId: "thread-9", until: "the invoice to be paid", callback: true },
        access,
      );
      // Another thread's callback wait in the same project never sees this link's calls.
      const other = yield* engine.startWait(
        { threadId: "thread-8", until: "the refund", callback: true },
        access,
      );
      const link = started.callback!;
      expect(link.path).toMatch(/^\/api\/hooks\/callback_[^/]+\/token_[^/]+$/);
      // Without Signalbox Connect there's no public address yet.
      expect(link.url).toBeNull();

      const wrong = yield* receiveCallback(callbackRequest(link.path, "{}", "token_nope"));
      expect(wrong).toEqual({ _tag: "not_found" });
      const paid = yield* receiveCallback(
        callbackRequest(link.path, JSON.stringify({ invoice: "in_1", status: "paid" })),
      );
      expect(paid._tag).toBe("accepted");
      yield* engine.drain;

      const messages = sent(tools);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.message).toContain("You were waiting for the invoice to be paid.");
      expect(messages[0]!.message).toContain('"status":"paid"');
      expect((yield* engine.getRun(started.waitId)).run.status).toBe("succeeded");
      expect((yield* engine.getRun(other.waitId)).run.status).toBe("running");
      // The run ended, so its link stopped answering.
      expect(yield* receiveCallback(callbackRequest(link.path, "{}"))).toEqual({
        _tag: "not_found",
      });
    }),
  );
});

it.effect("stop_waiting, settling and archiving each end a wait", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const wait = (threadId: string) =>
        engine.startWait({ threadId, until: "the merge", on: "pr.merged" }, access);
      const stopped = yield* wait("thread-1");
      const settled = yield* wait("thread-2");
      const archived = yield* wait("thread-3");
      yield* engine.drain;
      expect((yield* engine.listWaits("thread-1")).map((entry) => entry.waitId)).toEqual([
        stopped.waitId,
      ]);

      // Only the thread that owns a wait can stop it.
      const refused = yield* Effect.flip(engine.stopWait("thread-2", stopped.waitId));
      expect(refused.message).toContain("isn't one of this thread's waits");
      expect(yield* engine.stopWait("thread-1", stopped.waitId)).toBe(true);
      yield* threads.emit(threadEvent("thread.settled", "thread-2"));
      yield* threads.emit(threadEvent("thread.archived", "thread-3"));
      yield* engine.drain;

      for (const [threadId, { waitId }] of [
        ["thread-1", stopped],
        ["thread-2", settled],
        ["thread-3", archived],
      ] as const) {
        expect((yield* engine.getRun(waitId)).run.status).toBe("cancelled");
        expect(yield* engine.listWaits(threadId)).toEqual([]);
      }
    }),
  );
});

it.effect("a wait at a time wakes then; a timeout wakes saying nothing happened", () => {
  const threads = fakeThreads();
  const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      yield* engine.startWait(
        { threadId: "thread-1", until: "tomorrow morning", at: "1970-01-01T08:00:00.000Z" },
        access,
      );
      yield* engine.startWait(
        { threadId: "thread-2", until: "the merge", on: "pr.merged", timeout: { minutes: 5 } },
        access,
      );
      yield* engine.drain;
      yield* TestClock.adjust("6 minutes");
      yield* settle(engine);
      expect(sent(tools).map((message) => message.threadId)).toEqual(["thread-2"]);
      expect(sent(tools)[0]!.message).toContain("It didn't happen within 5 minutes");

      yield* TestClock.adjust("8 hours");
      yield* settle(engine);
      expect(sent(tools)[1]).toMatchObject({ threadId: "thread-1" });
      expect(sent(tools)[1]!.message).toContain("It's 1970-01-01T08:00:00.000Z.");
    }),
  );
});

it.effect("a wait needs exactly one thing to wait for, and a real event", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const neither = yield* Effect.flip(
        engine.startWait({ threadId: "thread-1", until: "something" }, access),
      );
      expect(neither.message).toContain("exactly one of on, callback or at");
      const both = yield* Effect.flip(
        engine.startWait(
          { threadId: "thread-1", until: "something", on: "pr.merged", callback: true },
          access,
        ),
      );
      expect(both.message).toContain("exactly one of on, callback or at");

      // Mistakes come back to the agent before anything starts.
      const typo = yield* Effect.flip(
        engine.startWait({ threadId: "thread-1", until: "the merge", on: "pr.merge" }, access),
      );
      expect(typo.message).toContain(
        'w.waitFor waits for an unknown event "pr.merge". Did you mean "pr.merged"',
      );
      const when = yield* Effect.flip(
        engine.startWait({ threadId: "thread-1", until: "later", at: "tomorrow" }, access),
      );
      expect(when.message).toContain('"tomorrow" isn\'t a time');
      expect(yield* engine.listWaits("thread-1")).toEqual([]);
    }),
  );
});

it.effect(
  "watch_pull_request wakes on others' comments and failed checks, and stops a chatty loop",
  () => {
    const threads = fakeThreads();
    const tools = fakeTools({
      t3_thread_send: { delivery: "queued" },
      link_pull_request: { alreadyLinked: false },
    });
    // What the host says has been written since each sync's previous `updatedAt`.
    let remarks: ReadonlyArray<Remark> = [];
    const remark = (author: string, body: string, kind: Remark["kind"] = "issue-comment") => ({
      id: `${author}-${body}`,
      kind,
      author,
      body,
      path: null,
      reviewState: kind === "review" ? "changes_requested" : null,
      url: null,
      at: "2026-10-06T10:00:00.000Z",
    });
    let minute = 0;
    const sync = (snapshot: { checksState?: string } = {}) =>
      threads.emit(
        pullRequestSynced("thread-9", {
          state: "open",
          updatedAt: `2026-10-06T11:${String(minute++).padStart(2, "0")}:00.000Z`,
          ...snapshot,
        }),
      );
    return withEngine(
      { threads },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        yield* engine.registerBuiltinTools(tools.handler);
        yield* engine.registerPullRequestReads({
          remarksSince: () => Effect.succeed(remarks),
          failedChecks: () =>
            Effect.succeed([{ name: "lint", status: "failure", url: "https://ci/lint" }]),
        });
        const request = {
          threadId: "thread-9",
          host: "github.com",
          repository: "acme/app",
          number: 12,
          url: PR_URL,
          watching: true,
        };
        expect(yield* engine.watchPullRequest(request, access)).toEqual({
          watching: true,
          wasWatching: false,
        });
        yield* engine.drain;
        expect(yield* engine.watchPullRequest(request, access)).toEqual({
          watching: true,
          wasWatching: true,
        });
        expect(tools.calls[0]).toMatchObject({
          tool: "link_pull_request",
          args: { threadId: "thread-9", url: PR_URL },
        });
        expect(monitorsOf("thread-9").map((task) => task.description)).toEqual([
          "Wait for news on the pull request",
        ]);

        yield* sync();
        remarks = [remark("reviewer", "Please rename this"), remark("bot", "LGTM", "review")];
        yield* sync();
        yield* engine.drain;
        remarks = [];
        yield* sync({ checksState: "failing" });
        yield* engine.drain;
        const [comments, reviews, failed] = sent(tools).map((message) => message.message);
        expect(comments).toContain('- reviewer: "Please rename this"');
        expect(comments).not.toContain("LGTM");
        expect(reviews).toContain('- bot: "LGTM"');
        expect(failed).toContain("- lint https://ci/lint");

        // A bot that keeps commenting: ten comment-only wakes in a row and the watch stops.
        remarks = [remark("bot", "again")];
        for (let wake = 0; wake < 10; wake += 1) {
          yield* sync();
          yield* engine.drain;
        }
        const last = sent(tools).at(-1)!.message;
        expect(last).toContain("I stopped watching after 10 comment-only updates in a row");
        expect(sent(tools)).toHaveLength(3 + 10);
        expect(monitorsOf("thread-9").map((task) => task.description)).toEqual([]);
      }),
    );
  },
);

it.effect(
  "a pull request watch gives up after repeated failed reads, telling the agent once",
  () => {
    const threads = fakeThreads();
    // list_thread_pull_requests has no answer: every read fails.
    const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
    return withEngine(
      { threads },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        yield* engine.registerBuiltinTools(tools.handler);
        const request = {
          threadId: "thread-9",
          host: "github.com",
          repository: "acme/app",
          number: 12,
          url: PR_URL,
          watching: true,
        };
        yield* engine.watchPullRequest({ ...request, url: "" }, access);
        yield* engine.drain;
        for (let pass = 0; pass < 8; pass += 1) {
          yield* TestClock.adjust("31 minutes");
          yield* settle(engine);
        }
        const messages = sent(tools);
        expect(messages).toHaveLength(1);
        expect(messages[0]!.message).toContain("I couldn't read pull request #12 8 times in a row");
        expect(monitorsOf("thread-9").map((task) => task.description)).toEqual([]);

        // unwatch_pull_request after it ended reports it wasn't watching.
        expect(yield* engine.watchPullRequest({ ...request, watching: false }, access)).toEqual({
          watching: false,
          wasWatching: false,
        });
      }),
    );
  },
);
