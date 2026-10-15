import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { WorkflowEngine } from "@signalbox/automations/WorkflowEngine";
import {
  DEFAULTS,
  fakeThreads,
  fakeTools,
  monitorsOf,
  saveOk,
  withEngine,
} from "./WorkflowEngine.testkit.ts";

const access = { builtInDefaults: DEFAULTS };
const PR_URL = "https://github.com/acme/app/pull/12";
const HEAD = "abc1234def5678";
/** What the host says about #12. */
const READ = {
  repository: "acme/app",
  number: 12,
  title: "Fix login",
  state: "open",
  headSha: HEAD,
};

const link = (source = "agent", state = "open") => ({
  host: "github.com",
  repository: "acme/app",
  number: 12,
  url: PR_URL,
  source,
  snapshot: { state },
});

/** thread-9 with pull request #12 linked. */
const linkedThreads = (source?: string, state?: string) => {
  const threads = fakeThreads();
  threads.state.shells["thread-9"] = { pullRequests: [link(source, state)] };
  return threads;
};

/** What the gate did through Signalbox's tools, in order. */
const actions = (tools: ReturnType<typeof fakeTools>) =>
  tools.calls.map((call) => {
    const args = call.args as { action?: string; message?: string };
    return call.tool === "pull_request_action"
      ? `action:${args.action}`
      : call.tool === "pull_request_read"
        ? "read"
        : `told:${args.message}`;
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
    return { runId: waitId, stepKey: ask.key, ask };
  });

it.effect(
  "merge_pull_request asks a person about a commit, then merges it and tells the agent",
  () => {
    const threads = linkedThreads();
    const tools = fakeTools({
      t3_thread_send: { delivery: "queued" },
      pull_request_read: READ,
      pull_request_action: { state: "merged", moved: false },
    });
    return withEngine(
      { threads },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        yield* engine.registerBuiltinTools(tools.handler);
        const ask = yield* requestMerge(engine, "Fixes login; tests pass.");
        // Nothing merges before someone says so, and the thread shows what it waits for.
        expect(actions(tools)).toEqual(["read"]);
        expect(monitorsOf("thread-9").map((task) => task.description)).toEqual([
          "Merge acme/app#12?",
        ]);
        // The person sees what the host says, pinned to the head commit.
        expect(ask.ask.args).toEqual([
          expect.objectContaining({
            question: `Fix login\n\n${PR_URL}\n\nAt abc1234.\n\nFixes login; tests pass.`,
          }),
        ]);

        yield* engine.answer({
          runId: ask.runId,
          stepKey: ask.stepKey,
          choice: "merge",
          values: {},
        });
        yield* engine.drain;
        expect(actions(tools)).toEqual([
          "read",
          "action:merge",
          "action:delete-branch",
          `told:Merged acme/app#12 (${PR_URL}) and deleted its branch. Wrap up and hand the work back.`,
        ]);
        expect(tools.calls[1]).toMatchObject({
          tool: "pull_request_action",
          args: { threadId: "thread-9", url: PR_URL, action: "merge", expectedHeadSha: HEAD },
        });
        expect((yield* engine.getRun(ask.runId)).output).toBe("merged");
        expect(monitorsOf("thread-9")).toEqual([]);
      }),
    );
  },
);

it.effect("commits pushed after the approval don't merge on it", () => {
  const threads = linkedThreads();
  const tools = fakeTools({
    t3_thread_send: { delivery: "queued" },
    pull_request_read: READ,
    pull_request_action: { state: "open", moved: true },
  });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const ask = yield* requestMerge(engine);
      yield* engine.answer({ runId: ask.runId, stepKey: ask.stepKey, choice: "merge", values: {} });
      yield* engine.drain;
      expect(actions(tools)).toEqual([
        "read",
        "action:merge",
        `told:Not merging acme/app#12 (${PR_URL}): new commits landed after it was approved at abc1234. Call merge_pull_request again so they can approve what's there now.`,
      ]);
      expect((yield* engine.getRun(ask.runId)).output).toBe("moved");
    }),
  );
});

it.effect("not yet tells the agent why, and nothing merges", () => {
  const threads = linkedThreads();
  const tools = fakeTools({ t3_thread_send: { delivery: "queued" }, pull_request_read: READ });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const ask = yield* requestMerge(engine);
      yield* engine.answer({
        runId: ask.runId,
        stepKey: ask.stepKey,
        choice: "not yet",
        values: { reason: "Add a test first." },
      });
      yield* engine.drain;
      expect(actions(tools)).toEqual([
        "read",
        `told:Not merging acme/app#12 (${PR_URL}) yet. They said: Add a test first. Do that, then call merge_pull_request again.`,
      ]);
    }),
  );
});

it.effect("a merge the host refuses or only queued goes back to the agent as such", () => {
  const threads = linkedThreads();
  // pull_request_action has no answer: the host refuses.
  const refusing = fakeTools({ t3_thread_send: { delivery: "queued" }, pull_request_read: READ });
  const queueing = fakeTools({
    t3_thread_send: { delivery: "queued" },
    pull_request_read: READ,
    pull_request_action: { state: "open", moved: false },
  });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(refusing.handler);
      const refused = yield* requestMerge(engine);
      yield* engine.answer({
        runId: refused.runId,
        stepKey: refused.stepKey,
        choice: "merge",
        values: {},
      });
      yield* engine.drain;
      const told = actions(refusing).at(-1)!;
      expect(told).toContain(`told:Merging acme/app#12 (${PR_URL}) failed:`);
      expect((yield* engine.getRun(refused.runId)).output).toBe("failed");

      yield* engine.registerBuiltinTools(queueing.handler);
      const queued = yield* requestMerge(engine);
      yield* engine.answer({
        runId: queued.runId,
        stepKey: queued.stepKey,
        choice: "merge",
        values: {},
      });
      yield* engine.drain;
      // No branch deletion while it waits in the queue.
      expect(actions(queueing)).toEqual([
        "read",
        "action:merge",
        `told:acme/app#12 (${PR_URL}) is approved and the host queued it to merge. Watch it with watch_pull_request; it merges when the queue gets to it.`,
      ]);
    }),
  );
});

it.effect("the ask names the pull request the host reports, not what the input claims", () => {
  const threads = linkedThreads();
  const tools = fakeTools({
    t3_thread_send: { delivery: "queued" },
    pull_request_read: { ...READ, number: 13, title: "Something else" },
  });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      // An agent running the gate itself with a misleading number gets no say in the title.
      const run = yield* engine.startRun({
        automationId: "builtin:merge-gate",
        input: { threadId: "thread-9", url: PR_URL, number: 12, repository: "acme/app" },
        trigger: "manual",
        projectId: "project-automations",
        builtInDefaults: DEFAULTS,
      });
      yield* engine.drain;
      const ask = (yield* engine.getRun(run.id)).steps.find((step) => step.verb === "ask");
      expect(ask?.label).toBe("Merge acme/app#13?");
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

      threads.state.shells["thread-9"] = { pullRequests: [link("agent", "merged")] };
      expect((yield* Effect.flip(ask("thread-9"))).message).toContain("is already merged");
      // A stacked pull request the user dismissed isn't the thread's anymore.
      threads.state.shells["thread-9"] = { pullRequests: [link("stack-dismissed")] };
      expect((yield* Effect.flip(ask("thread-9"))).message).toContain(
        "isn't linked to this thread",
      );
    }),
  );
});

it.effect("an automation an agent saved can't merge; one a person published can", () => {
  const threads = linkedThreads();
  const tools = fakeTools({ pull_request_action: { state: "merged", moved: false } });
  const source = (
    name: string,
    threadId: string,
  ) => `export const meta = { name: "${name}" } as const;
export default workflow(async (w) => {
  return await w.call("Merge it", "signalbox.pull_request_action", { threadId: "${threadId}", url: "${PR_URL}", action: "merge" });
});`;
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const run = (automationId: string) =>
        Effect.gen(function* () {
          const started = yield* engine.startRun({ automationId, trigger: "manual" });
          yield* engine.drain;
          return (yield* engine.getRun(started.id)).run;
        });

      // Saved by an agent: refused before anything reaches the host.
      const sneaky = yield* saveOk(source("Merge quietly", "thread-9"));
      const refused = yield* run(sneaky.id);
      expect(refused.status).toBe("failed");
      expect(refused.error).toContain(
        "Only Signalbox's own automations, or one a person published",
      );
      expect(tools.calls).toEqual([]);

      // The same code as a draft a person published in the app.
      const draft = yield* engine.save({
        source: source("Merge on green", "thread-9"),
        projectId: "project-automations" as never,
        defaults: DEFAULTS,
        draft: true,
      });
      if (!draft.ok) throw new Error("draft didn't save");
      yield* engine.publish(draft.automation.id, { version: draft.automation.draftVersion! });
      expect((yield* run(draft.automation.id)).status).toBe("succeeded");
      expect(tools.calls.map((call) => call.tool)).toEqual(["pull_request_action"]);

      // Even then, only on threads of its own project.
      threads.state.shells["thread-elsewhere"] = { projectId: "project-other" };
      const away = yield* engine.save({
        source: source("Merge elsewhere", "thread-elsewhere"),
        projectId: "project-automations" as never,
        defaults: DEFAULTS,
        draft: true,
      });
      if (!away.ok) throw new Error("draft didn't save");
      yield* engine.publish(away.automation.id, { version: away.automation.draftVersion! });
      const elsewhere = yield* run(away.automation.id);
      expect(elsewhere.status).toBe("failed");
      expect(elsewhere.error).toContain("only acts on threads in the automation's own project");
    }),
  );
});

it.effect("publishing vouches only for the draft version the person reviewed", () => {
  const threads = linkedThreads();
  const tools = fakeTools({ pull_request_action: { state: "merged", moved: false } });
  const source = (step: string) => `export const meta = { name: "Merge on green" } as const;
export default workflow(async (w) => {
  return await w.call("${step}", "signalbox.pull_request_action", { threadId: "thread-9", url: "${PR_URL}", action: "merge" });
});`;
  const saveDraft = (step: string) =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const saved = yield* engine.save({
        source: source(step),
        projectId: "project-automations" as never,
        defaults: DEFAULTS,
        draft: true,
      });
      if (!saved.ok) throw new Error("draft didn't save");
      return saved.automation;
    });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const reviewed = yield* saveDraft("Merge it");
      // An agent saves a newer draft after the person looked at the first one.
      const swapped = yield* saveDraft("Merge it now");
      expect(swapped.draftVersion).not.toBe(reviewed.draftVersion);
      const refused = yield* Effect.flip(
        engine.publish(reviewed.id, { version: reviewed.draftVersion! }),
      );
      expect(refused.message).toContain("The draft changed since you looked");

      // Publishing without saying which version goes live but vouches for nothing.
      yield* engine.publish(reviewed.id);
      const started = yield* engine.startRun({ automationId: reviewed.id, trigger: "manual" });
      yield* engine.drain;
      expect((yield* engine.getRun(started.id)).run.error).toContain(
        "Only Signalbox's own automations, or one a person published",
      );
      expect(tools.calls).toEqual([]);
    }),
  );
});

it.effect("an approval the host can't pin to a commit says so", () => {
  const threads = linkedThreads();
  const tools = fakeTools({ pull_request_read: { ...READ, headSha: null } });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const ask = yield* requestMerge(engine);
      expect(ask.ask.args).toEqual([
        expect.objectContaining({
          question: expect.stringContaining("this approval isn't pinned to one"),
        }),
      ]);
    }),
  );
});
