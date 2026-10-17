import { describe, expect, it } from "vite-plus/test";

import { TASK_DONE } from "@signalbox/automations/defaults/taskDone";
import { compileWorkflow } from "./compileWorkflow.ts";

const compiled = compileWorkflow(TASK_DONE);
if (compiled.ok === false) throw new Error(JSON.stringify(compiled.diagnostics, null, 2));
const workerModule = compiled.ok === true ? compiled.workflow.workerModule! : "";

type Receiver = Record<string, (...args: Array<unknown>) => unknown>;
type Body = (w: Receiver, input: unknown, event?: unknown) => Promise<unknown>;

async function loadBody(): Promise<Body> {
  const module = await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(workerModule)}`
  );
  return module.load((body: Body) => body) as Body;
}

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
type PullRequest = {
  host: string;
  repository: string;
  number: number;
  url: string;
  source?: string;
  snapshot: { state: string; mergedAt: string | null } | null;
};
type LifecycleState = {
  kind: "task" | "chat";
  thread: {
    id: string;
    title: string;
    updatedAt: string;
    unsettledAt: string | null;
    archivedAt: string | null;
    settledAt: string | null;
    settledOverride: "settled" | "active" | null;
    pullRequests: PullRequest[];
  };
  runs: Array<{ status: string }>;
  messages: Array<{ role: string; text: string }>;
  record: { generation: number; condition: { summary: string; input?: unknown } | null } | null;
  applied: boolean;
};

const mergedPullRequest: PullRequest = {
  host: "github.com",
  repository: "example/project",
  number: 42,
  url: "https://github.com/example/project/pull/42",
  snapshot: { state: "merged", mergedAt: "2026-10-17T09:00:00.000Z" },
};
const unmergedPullRequest: PullRequest = {
  ...mergedPullRequest,
  snapshot: { state: "open", mergedAt: null },
};

const lifecycle = (overrides: Partial<LifecycleState> = {}): LifecycleState => ({
  kind: "task",
  thread: {
    id: "task-1",
    title: "Finish the task",
    updatedAt: "2026-10-17T09:00:00.000Z",
    unsettledAt: null,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    pullRequests: [mergedPullRequest],
  },
  runs: [],
  messages: [{ role: "user", text: "Please finish this useful work." }],
  record: { generation: 4, condition: null },
  applied: false,
  ...overrides,
});

function fixture(
  options: {
    kind?: "task" | "chat";
    pullRequests?: PullRequest[];
    archivedThreadIds?: string[];
    recordCondition?: { summary: string; input?: unknown } | null;
    verification?: Array<{ state: string; evidence?: string; commit?: string }>;
    wait?: (label: string, args: Record<string, unknown>) => unknown;
    staleAfterVerification?: "generation" | "message";
  } = {},
) {
  let generation = 4;
  let condition = options.recordCondition ?? null;
  let updatedAt = "2026-10-17T09:00:00.000Z";
  let pullRequests = options.pullRequests ?? [mergedPullRequest];
  const archivedThreadIds = new Set(options.archivedThreadIds ?? []);
  let verificationText = "";
  const verificationReplies = [...(options.verification ?? [])];
  const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const waits: Array<{ label: string; args: Record<string, unknown> }> = [];
  const agents: Array<Record<string, unknown>> = [];
  const llmCalls: string[] = [];
  const timeline: string[] = [];
  let sourceReads = 0;

  const sourceState = (threadId = "task-1") =>
    lifecycle({
      kind: options.kind ?? "task",
      thread: {
        ...lifecycle().thread,
        id: threadId,
        updatedAt: threadId === "task-1" ? updatedAt : "2026-10-17T08:00:00.000Z",
        archivedAt: archivedThreadIds.has(threadId) ? "2026-10-17T08:00:00.000Z" : null,
        pullRequests: threadId === "task-1" ? pullRequests : [],
      },
      record: { generation, condition },
    });
  const verifierState = () =>
    lifecycle({
      thread: { ...lifecycle().thread, id: "verification-1", pullRequests: [] },
      messages: [{ role: "assistant", text: verificationText }],
      record: { generation: 0, condition: null },
    });

  const w = {
    $arm: () => {},
    $frame: () => w,
    call: async (...args: Array<unknown>) => {
      const operationIndex = args.findIndex(
        (arg) => typeof arg === "string" && String(arg).includes("."),
      );
      const operation = String(args[operationIndex]);
      const actionArgs = args[operationIndex + 1] as Record<string, unknown>;
      const action = String(actionArgs.action);
      const threadId = String(actionArgs.threadId);
      calls.push({ operation, args: actionArgs });
      timeline.push(`call:${action}`);

      if (operation !== "signalbox.task_lifecycle") return { applied: true };
      if (action === "read") {
        if (threadId === "verification-1") return verifierState();
        if (threadId !== "task-1") return sourceState(threadId);
        sourceReads++;
        if (options.staleAfterVerification && sourceReads > 1 && verificationText) {
          if (options.staleAfterVerification === "generation") generation++;
          if (options.staleAfterVerification === "message") {
            updatedAt = "2026-10-17T10:00:00.000Z";
            const state = sourceState();
            state.messages.push({ role: "user", text: "One more thing." });
            return state;
          }
        }
        return sourceState();
      }
      if (action === "propose") {
        generation++;
        condition = { summary: String(actionArgs.summary), input: actionArgs.input };
        return { ...sourceState(), applied: true };
      }
      if (action === "complete") {
        if (actionArgs.expectedGeneration !== generation) return sourceState();
        const state = sourceState();
        state.thread.archivedAt = "2026-10-17T10:00:00.000Z";
        return { ...state, applied: true };
      }
      throw new Error(`Unexpected task lifecycle action: ${action}`);
    },
    agent: async (...args: Array<unknown>) => {
      const request = args.at(-1) as Record<string, unknown>;
      agents.push(request);
      timeline.push("agent");
      const reply = verificationReplies.shift() ?? {
        state: "live",
        evidence: "Production smoke check passed.",
        commit: COMMIT,
      };
      verificationText = JSON.stringify({
        state: reply.state,
        evidence: reply.evidence ?? `Observed ${reply.state} deployment state.`,
        commit: reply.commit ?? COMMIT,
      });
      return { threadId: `verification-${agents.length}`, text: verificationText };
    },
    waitFor: async (...args: Array<unknown>) => {
      const label = String(args[1]);
      const waitArgs = args.at(-1) as Record<string, unknown>;
      waits.push({ label, args: waitArgs });
      timeline.push(`wait:${label}`);
      return options.wait ? options.wait(label, waitArgs) : null;
    },
    sleep: async (...args: Array<unknown>) => {
      timeline.push(`sleep:${String(args[1])}`);
      return undefined;
    },
    llm: async (...args: Array<unknown>) => {
      const label = String(args[1]);
      llmCalls.push(label);
      if (label === "Propose when this task is done")
        return JSON.stringify({
          summary: "The requested result is ready",
          criteria: "The requested result is present.",
        });
      if (label === "Does the task meet its done-condition?") return "done";
      return "The requested result is ready.";
    },
  };

  return {
    w,
    calls,
    waits,
    agents,
    llmCalls,
    timeline,
    setVerificationText: (text: string) => {
      verificationText = text;
    },
    setPullRequests: (value: PullRequest[]) => {
      pullRequests = value;
    },
    setUpdatedAt: (value: string) => {
      updatedAt = value;
    },
    run: async (input: unknown = { threadId: "task-1" }, event: unknown = {}) =>
      (await loadBody())(w, input, event),
  };
}

describe("Task done automation", () => {
  it("archives the default merged-PR condition only after live or no-deploy proof", async () => {
    for (const state of ["live", "none"] as const) {
      const test = fixture({ verification: [{ state }] });
      await test.run({ threadId: "task-1", event: "thread.created" });

      const complete = test.calls.find((call) => call.args.action === "complete");
      expect(complete?.args.outcome).toContain(state === "live" ? "Live at" : "Merged at");
      expect(test.agents).toHaveLength(1);
    }
  });

  it("keeps an unknown deployment proof waiting on the verifier thread", async () => {
    const waiting = new Error("expected workflow wait");
    const test = fixture({
      verification: [{ state: "unknown", evidence: "Deployment access is missing." }],
      wait: () => {
        throw waiting;
      },
    });

    await expect(test.run({ threadId: "task-1", event: "thread.created" })).rejects.toBe(waiting);
    expect(test.waits).toEqual([
      {
        label: "Wait for deployment evidence",
        args: { on: "turn.finished", where: { threadId: "verification-1" } },
      },
    ]);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(false);
  });

  it("reports a failed deployment, waits for the task repair, then verifies again", async () => {
    const test = fixture({
      verification: [
        { state: "failed", evidence: "Production returned HTTP 500." },
        { state: "live", evidence: "Production smoke check passed." },
      ],
      wait: (label, args) => {
        if (label !== "Wait for the deployment repair")
          throw new Error(`Unexpected wait: ${label}`);
        expect(args).toMatchObject({ on: "turn.finished", where: { threadId: "task-1" } });
        test.setUpdatedAt("2026-10-17T09:30:00.000Z");
        return { event: "turn.finished", threadId: "task-1" };
      },
    });

    await test.run({ threadId: "task-1", event: "thread.created" });

    expect(
      test.calls.find((call) => call.operation === "signalbox.t3_thread_send")?.args,
    ).toMatchObject({
      threadId: "task-1",
      mode: "queue",
    });
    expect(test.agents).toHaveLength(2);
    expect(test.timeline.indexOf("wait:Wait for the deployment repair")).toBeLessThan(
      test.timeline.lastIndexOf("agent"),
    );
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(true);
  });

  it("rejects proof when the condition generation or task message changes during verification", async () => {
    for (const staleAfterVerification of ["generation", "message"] as const) {
      const test = fixture({
        verification: [{ state: "unknown", evidence: "Waiting for a production check." }],
        staleAfterVerification,
        wait: () => {
          testMessageReply();
          return { event: "turn.finished", threadId: "verification-1" };
        },
      });
      const testMessageReply = () => {
        // The verifier supplies valid evidence after the task has changed.
        test.setVerificationText(
          JSON.stringify({
            state: "live",
            commit: COMMIT,
            evidence: "Production smoke check passed.",
          }),
        );
      };

      await test.run({ threadId: "task-1", event: "thread.created" });
      expect(test.calls.some((call) => call.args.action === "complete")).toBe(false);
    }
  });

  it("leaves chats without a task done-condition", async () => {
    const test = fixture({ kind: "chat" });

    await expect(test.run({ threadId: "task-1", event: "thread.created" })).resolves.toBe(
      "Chats have no done-condition.",
    );
    expect(test.calls).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ action: "read" }) }),
    ]);
    expect(test.llmCalls).toEqual([]);
  });

  it("uses the folder LLM to propose an observable condition when no PR is linked", async () => {
    const test = fixture({ pullRequests: [] });

    await test.run({ threadId: "task-1", event: "thread.created" });

    const proposed = test.calls.find((call) => call.args.action === "propose");
    expect(proposed?.args).toMatchObject({
      automationId: "builtin:task-done",
      input: {
        type: "outcome",
        criteria: "The requested result is present.",
        defaultProposal: true,
      },
    });
    expect(test.llmCalls).toContain("Propose when this task is done");
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(true);
  });

  it("satisfies an all condition from a future date and a matching event", async () => {
    const test = fixture({
      recordCondition: { summary: "Docs ready", input: null },
      wait: (label, args) => {
        expect(label).toBe("Wait for a done-condition event");
        expect(args).toMatchObject({
          on: ["docs.ready"],
        });
        return {
          event: "docs.ready",
          threadId: "task-1",
          workspace: "docs",
          at: "2026-10-17T12:00:00.000Z",
        };
      },
    });

    await test.run({
      threadId: "task-1",
      condition: {
        type: "all",
        conditions: [
          { type: "date", at: "2026-10-17T11:00:00.000Z" },
          { type: "event", on: "docs.ready", where: { workspace: "docs" } },
        ],
      },
      expectedGeneration: 4,
      at: "2026-10-17T10:00:00.000Z",
    });

    expect(test.calls.some((call) => call.args.action === "complete")).toBe(true);
  });

  it("watches a taskArchived condition on the named task", async () => {
    const test = fixture({
      recordCondition: { summary: "Source archived", input: null },
      wait: (label, args) => {
        expect(label).toBe("Wait for the task dependency or pull request");
        expect(args).toMatchObject({ on: ["thread.archived", "pr.merged", "pr.updated"] });
        return {
          event: "thread.archived",
          threadId: "source-task",
          at: "2026-10-17T10:00:00.000Z",
        };
      },
    });

    await test.run({
      threadId: "task-1",
      condition: { type: "taskArchived", taskThreadId: "source-task" },
      expectedGeneration: 4,
    });

    expect(test.calls.some((call) => call.args.action === "complete")).toBe(true);
  });

  it("satisfies taskArchived immediately when its named dependency is already archived", async () => {
    const test = fixture({ archivedThreadIds: ["source-task"] });

    await test.run({
      threadId: "task-1",
      condition: { type: "taskArchived", taskThreadId: "source-task" },
      expectedGeneration: 4,
    });

    expect(
      test.calls.some(
        (call) => call.args.action === "read" && call.args.threadId === "source-task",
      ),
    ).toBe(true);
    expect(test.waits).toEqual([]);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(true);
  });

  it("lets an already-held any branch finish without waiting for unknown PR proof", async () => {
    const test = fixture({
      recordCondition: { summary: "Date reached", input: null },
      verification: [{ state: "unknown", evidence: "Deployment is not checked." }],
    });

    await test.run({
      threadId: "task-1",
      condition: {
        type: "any",
        conditions: [
          { type: "date", at: "2026-10-17T09:00:00.000Z" },
          { type: "pullRequestsMergedAndLive" },
        ],
      },
      expectedGeneration: 4,
      at: "2026-10-17T10:00:00.000Z",
    });

    expect(test.agents).toEqual([]);
    expect(test.waits).toEqual([]);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(true);
  });

  it("still waits for merged and live proof inside an all condition", async () => {
    const test = fixture({
      pullRequests: [unmergedPullRequest],
      recordCondition: { summary: "Merged and live after date", input: null },
      wait: (label, args) => {
        expect(label).toBe("Wait for the task dependency or pull request");
        expect(args.on).toEqual(["thread.archived", "pr.merged", "pr.updated"]);
        test.setPullRequests([mergedPullRequest]);
        return { event: "pr.merged", threadId: "task-1", at: "2026-10-17T12:00:00.000Z" };
      },
    });

    await test.run({
      threadId: "task-1",
      condition: {
        type: "all",
        conditions: [
          { type: "date", at: "2026-10-17T11:00:00.000Z" },
          { type: "pullRequestsMergedAndLive" },
        ],
      },
      expectedGeneration: 4,
      at: "2026-10-17T10:00:00.000Z",
    });

    expect(test.agents).toHaveLength(1);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(true);
  });
});
