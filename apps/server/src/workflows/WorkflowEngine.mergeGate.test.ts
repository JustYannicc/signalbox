import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { WorkflowEngine } from "./WorkflowEngine.ts";
import {
  DEFAULTS,
  fakeThreads,
  fakeTools,
  monitorsOf,
  withEngine,
} from "./WorkflowEngine.testkit.ts";

const access = { builtInDefaults: DEFAULTS };
const PR_URL = "https://github.com/acme/app/pull/12";

/** thread-9 with pull request #12 linked, in `state`. */
const linkedThreads = (state = "open") => {
  const threads = fakeThreads();
  threads.state.shells["thread-9"] = {
    pullRequests: [
      {
        host: "github.com",
        repository: "acme/app",
        number: 12,
        url: PR_URL,
        source: "agent",
        snapshot: { state },
      },
    ],
  };
  return threads;
};

/** What the gate did through Signalbox's tools, in order. */
const actions = (tools: ReturnType<typeof fakeTools>) =>
  tools.calls.map((call) => {
    const args = call.args as { action?: string; message?: string };
    return call.tool === "pull_request_action" ? `action:${args.action}` : `told:${args.message}`;
  });

/** Starts a merge request on thread-9 and returns its run, waiting on the person. */
const requestMerge = (engine: WorkflowEngine["Service"], note?: string) =>
  Effect.gen(function* () {
    const { waitId } = yield* engine.requestMerge(
      { threadId: "thread-9", url: PR_URL, note },
      access,
    );
    yield* engine.drain;
    const detail = yield* engine.getRun(waitId);
    const ask = detail.steps.find((step) => step.verb === "ask" && step.status === "waiting");
    if (!ask) throw new Error("The gate isn't asking.");
    return { runId: waitId, stepKey: ask.key };
  });

it.effect(
  "merge_pull_request asks a person, then merges, deletes the branch and tells the agent",
  () => {
    const threads = linkedThreads();
    const tools = fakeTools({
      t3_thread_send: { delivery: "queued" },
      pull_request_action: { state: "merged" },
    });
    return withEngine(
      { threads },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        yield* engine.registerBuiltinTools(tools.handler);
        const ask = yield* requestMerge(engine, "Fixes login; tests pass.");
        // Nothing merges before someone says so, and the thread shows what it waits for.
        expect(tools.calls).toEqual([]);
        expect(monitorsOf("thread-9").map((task) => task.description)).toEqual([
          "Merge acme/app#12?",
        ]);
        expect(
          (yield* engine.getRun(ask.runId)).steps.find((step) => step.verb === "ask"),
        ).toMatchObject({
          args: [expect.objectContaining({ question: `${PR_URL}\n\nFixes login; tests pass.` })],
        });

        yield* engine.answer({ ...ask, choice: "merge", values: {} });
        yield* engine.drain;
        expect(actions(tools)).toEqual([
          "action:merge",
          "action:delete-branch",
          `told:Merged acme/app#12 (${PR_URL}) and deleted its branch. Wrap up and hand the work back.`,
        ]);
        expect(tools.calls[0]).toMatchObject({
          tool: "pull_request_action",
          args: { threadId: "thread-9", url: PR_URL, action: "merge" },
        });
        expect((yield* engine.getRun(ask.runId)).output).toBe("merged");
        expect(monitorsOf("thread-9")).toEqual([]);
      }),
    );
  },
);

it.effect("not yet tells the agent why, and nothing merges", () => {
  const threads = linkedThreads();
  const tools = fakeTools({
    t3_thread_send: { delivery: "queued" },
    pull_request_action: { state: "merged" },
  });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const ask = yield* requestMerge(engine);
      yield* engine.answer({ ...ask, choice: "not yet", values: { reason: "Add a test first." } });
      yield* engine.drain;
      expect(actions(tools)).toEqual([
        `told:Not merging acme/app#12 (${PR_URL}) yet. They said: Add a test first. Do that, then call merge_pull_request again.`,
      ]);
    }),
  );
});

it.effect("a merge the host refuses goes back to the agent instead of failing silently", () => {
  const threads = linkedThreads();
  // pull_request_action has no answer: the host refuses.
  const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const ask = yield* requestMerge(engine);
      yield* engine.answer({ ...ask, choice: "merge", values: {} });
      yield* engine.drain;
      const told = actions(tools).at(-1)!;
      expect(told).toContain(`told:Merging acme/app#12 (${PR_URL}) failed:`);
      expect(told).toContain("then call merge_pull_request again");
      expect((yield* engine.getRun(ask.runId)).output).toBe("failed");

      const wrong = yield* Effect.flip(
        engine.requestMerge({ threadId: "thread-9", url: "not a url" }, access),
      );
      expect(wrong.message).toContain("isn't a pull request URL");
    }),
  );
});

it.effect("a merge the host only queued isn't reported as merged", () => {
  const threads = linkedThreads();
  const tools = fakeTools({
    t3_thread_send: { delivery: "queued" },
    pull_request_action: { state: "open" },
  });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const ask = yield* requestMerge(engine);
      yield* engine.answer({ ...ask, choice: "merge", values: {} });
      yield* engine.drain;
      // No branch deletion while it waits in the queue.
      expect(actions(tools)).toEqual([
        "action:merge",
        `told:acme/app#12 (${PR_URL}) is approved and the host queued it to merge. Watch it with watch_pull_request; it merges when the queue gets to it.`,
      ]);
      expect((yield* engine.getRun(ask.runId)).output).toBe("queued");
    }),
  );
});

it.effect("only the thread's own open pull request can be asked for, once at a time", () => {
  const threads = linkedThreads();
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const ask = (threadId: string, url = PR_URL) =>
        engine.requestMerge({ threadId, url }, access);
      const other = yield* Effect.flip(ask("thread-9", "https://github.com/acme/app/pull/13"));
      expect(other.message).toContain("isn't linked to this thread");
      const elsewhere = yield* Effect.flip(ask("thread-1"));
      expect(elsewhere.message).toContain("isn't linked to this thread");

      const first = yield* ask("thread-9");
      yield* engine.drain;
      expect(first.alreadyRequested).toBe(false);
      expect(yield* ask("thread-9")).toEqual({ waitId: first.waitId, alreadyRequested: true });

      threads.state.shells["thread-9"] = {
        pullRequests: [
          {
            host: "github.com",
            repository: "acme/app",
            number: 12,
            url: PR_URL,
            source: "agent",
            snapshot: { state: "merged" },
          },
        ],
      };
      const done = yield* Effect.flip(ask("thread-9"));
      expect(done.message).toContain("is already merged");
    }),
  );
});
