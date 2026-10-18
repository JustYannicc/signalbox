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
  messages: Array<{ role: string; text: string; id?: string }>;
  record: { generation: number; condition: { summary: string; input?: unknown } | null } | null;
  applied: boolean;
  modelSteps?: boolean;
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
    messages?: LifecycleState["messages"];
    pullRequests?: PullRequest[];
    unsettledAt?: string | null;
    otherThreads?: Record<string, { archivedAt?: string | null; unsettledAt?: string | null }>;
    recordCondition?: { summary: string; input?: unknown } | null;
    verification?: Array<{ state: string; evidence?: string; commit?: string; runId?: string }>;
    deployment?: { status: "pending" | "failed" | "succeeded"; commit?: string };
    deploymentRead?: (args: Record<string, unknown>) => void;
    onAgent?: () => void;
    wait?: (label: string, args: Record<string, unknown>) => unknown;
    staleAfterVerification?: "generation" | "message";
    modelSteps?: boolean;
  } = {},
) {
  let generation = 4;
  let condition = options.recordCondition ?? null;
  let updatedAt = "2026-10-17T09:00:00.000Z";
  let pullRequests = options.pullRequests ?? [mergedPullRequest];
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
      messages: options.messages ?? lifecycle().messages,
      thread: {
        ...lifecycle().thread,
        id: threadId,
        updatedAt: threadId === "task-1" ? updatedAt : "2026-10-17T08:00:00.000Z",
        unsettledAt:
          threadId === "task-1"
            ? (options.unsettledAt ?? null)
            : (options.otherThreads?.[threadId]?.unsettledAt ?? null),
        archivedAt:
          threadId === "task-1" ? null : (options.otherThreads?.[threadId]?.archivedAt ?? null),
        pullRequests: threadId === "task-1" ? pullRequests : [],
      },
      record: { generation, condition },
      ...(options.modelSteps === undefined ? {} : { modelSteps: options.modelSteps }),
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
    eventCursor: async () => ({ runId: "run-1", sequence: 0 }),
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

      if (operation === "signalbox.pull_request_deployment") {
        options.deploymentRead?.(actionArgs);
        return {
          commit: COMMIT,
          baseBranch: "main",
          run:
            actionArgs.runId === undefined
              ? null
              : {
                  id: String(actionArgs.runId),
                  url: "https://github.com/example/project/actions/runs/123",
                  status: options.deployment?.status ?? "succeeded",
                  commit: options.deployment?.commit ?? COMMIT,
                },
        };
      }
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
      options.onAgent?.();
      const reply = verificationReplies.shift() ?? {
        state: "live",
        evidence: "Production smoke check passed.",
        commit: COMMIT,
      };
      verificationText = JSON.stringify({
        state: reply.state,
        evidence: reply.evidence ?? `Observed ${reply.state} deployment state.`,
        commit: reply.commit ?? COMMIT,
        runId: reply.runId ?? "123",
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
      verificationText = JSON.stringify({ runId: "123", ...JSON.parse(text) });
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
  it("does not propose conditions for an automation's helper thread", async () => {
    const setup = fixture({
      messages: [
        { id: "automation:run:step:message", role: "user", text: "Judge the original task" },
      ],
    });
    const body = await loadBody();
    await body(setup.w, { threadId: "task-1" }, { event: "thread.created" });
    expect(setup.llmCalls).toEqual([]);
    expect(setup.agents).toEqual([]);
    expect(setup.calls.every((call) => call.args.action === "read")).toBe(true);
  });
  it("archives the default merged-PR condition only after live or no-deploy proof", async () => {
    for (const state of ["live", "none"] as const) {
      const test = fixture({ verification: [{ state }] });
      await test.run({ threadId: "task-1", event: "thread.created" });

      const complete = test.calls.find((call) => call.args.action === "complete");
      expect(complete?.args.outcome).toContain(state === "live" ? "Live at" : "Merged at");
      expect(test.agents).toHaveLength(1);
    }
  });

  it("archives long PR stacks with intact deployment links within the outcome limit", async () => {
    for (const count of [7, 40]) {
      const test = fixture({
        pullRequests: Array.from({ length: count }, (_, index) => ({
          ...mergedPullRequest,
          number: index + 1,
          url: `https://github.com/example/project/pull/${index + 1}`,
        })),
      });
      await test.run({ threadId: "task-1", event: "thread.created" });

      const outcome = test.calls.find((call) => call.args.action === "complete")?.args.outcome;
      expect(typeof outcome).toBe("string");
      const text = String(outcome);
      const linkPattern =
        /\[Live at [a-f0-9]{12}\]\((https:\/\/github\.com\/example\/project\/actions\/runs\/\d+)\)/g;
      const links = Array.from(text.matchAll(linkPattern));
      expect(test.agents).toHaveLength(count);
      expect(text.length).toBeLessThanOrEqual(2000);
      expect(links.length).toBeGreaterThanOrEqual(7);
      expect(text.replace(linkPattern, "").replaceAll("; ", "")).toBe("");
      for (const link of links)
        expect(link[1]).toBe("https://github.com/example/project/actions/runs/123");
    }
  });

  it.each(["missing connection", "GitHub API unavailable"])(
    "recovers an initial merge read after %s",
    async (failure) => {
      let attempts = 0;
      const test = fixture({
        deploymentRead: () => {
          if (++attempts <= 2) throw new Error(failure);
        },
        wait: (label, args) => {
          expect(label).toBe("Wait for merge evidence access");
          expect(args.timeout).toEqual({ minutes: 1 });
          expect(test.agents).toHaveLength(0);
          expect(test.calls.some((call) => call.args.action === "complete")).toBe(false);
          return null;
        },
      });
      await test.run({ threadId: "task-1", event: "thread.created" });
      expect(test.waits).toHaveLength(2);
      expect(test.agents).toHaveLength(1);
      expect(test.calls.some((call) => call.args.action === "complete")).toBe(true);
    },
  );

  it.each(["during verification", "while waiting"])(
    "drops an unlinked PR %s and completes from the remaining proof",
    async (when) => {
      const second = {
        ...mergedPullRequest,
        number: 43,
        url: "https://github.com/example/project/pull/43",
      };
      const stop = new Error("unlink did not restart verification");
      let removed = false;
      const unlink = () => {
        removed = true;
        test.setPullRequests([mergedPullRequest]);
      };
      const test = fixture({
        pullRequests: [mergedPullRequest, second],
        verification: [{ state: "live" }, { state: "unknown" }],
        onAgent: () => {
          if (when === "during verification" && test.agents.length === 2) unlink();
        },
        deploymentRead: (args) => {
          if (removed && args.url === second.url) throw new Error("PR no longer linked");
        },
        wait: (label, args) => {
          if (removed) throw stop;
          expect(label).toBe("Wait for deployment evidence");
          expect(args.on).toContain("pr.updated");
          expect(args.where).toBeUndefined();
          unlink();
          return { event: "pr.updated", threadId: "task-1" };
        },
      });
      await test.run({ threadId: "task-1", event: "thread.created" });
      expect(test.agents).toHaveLength(2);
      expect(test.calls.find((call) => call.args.action === "complete")?.args.outcome).toBe(
        `[Live at ${COMMIT.slice(0, 12)}](https://github.com/example/project/actions/runs/123)`,
      );
    },
  );

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
        args: {
          on: ["turn.finished", "pr.updated", "thread.archived"],
          after: { runId: "run-1", sequence: 0 },
        },
      },
    ]);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(false);
  });

  it("rejects a verifier's live claim for another commit and requests corrected proof", async () => {
    const waiting = new Error("waiting for exact commit proof");
    const test = fixture({
      verification: [{ state: "live", commit: "b".repeat(40) }],
      wait: () => {
        throw waiting;
      },
    });
    await expect(test.run({ threadId: "task-1", event: "thread.created" })).rejects.toBe(waiting);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(false);
    expect(
      test.calls.find((call) => call.operation === "signalbox.t3_thread_send")?.args,
    ).toMatchObject({
      threadId: "verification-1",
      message: expect.stringContaining(COMMIT),
    });
  });

  it("keeps a premature live claim waiting while the actual deployment is pending", async () => {
    const waiting = new Error("waiting for deploy");
    const test = fixture({
      deployment: { status: "pending" },
      verification: [{ state: "live" }],
      wait: () => {
        throw waiting;
      },
    });
    await expect(test.run({ threadId: "task-1", event: "thread.created" })).rejects.toBe(waiting);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(false);
    expect(
      test.calls.find((call) => call.operation === "signalbox.t3_thread_send")?.args,
    ).toMatchObject({
      threadId: "verification-1",
      message: expect.stringContaining("still pending"),
    });
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
        expect(args).toMatchObject({
          on: ["turn.finished", "pr.updated", "thread.archived"],
          where: { threadId: "task-1" },
        });
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

  it("drops proof when the generation changes, and keeps evaluating when only the task changed", async () => {
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
      const complete = test.calls.find((call) => call.args.action === "complete");
      if (staleAfterVerification === "generation") expect(complete).toBeUndefined();
      // A rename or a message during verification must not strand the evaluator.
      else expect(complete?.args.expectedUpdatedAt).toBe("2026-10-17T10:00:00.000Z");
    }
  });

  it("verifies a pull request linked after the others were proven before archiving", async () => {
    const stop = new Error("still waiting");
    const secondPullRequest: PullRequest = {
      ...unmergedPullRequest,
      number: 43,
      url: "https://github.com/example/project/pull/43",
    };
    let waits = 0;
    const test = fixture({
      wait: (label) => {
        waits++;
        if (waits === 1) {
          // PR 42 is proven; PR 43 gets linked while the date is still ahead.
          test.setPullRequests([mergedPullRequest, secondPullRequest]);
          test.setUpdatedAt("2026-10-17T09:30:00.000Z");
          return null;
        }
        expect(label).toBe("Wait for the task dependency or pull request");
        if (waits === 2) {
          test.setPullRequests([
            mergedPullRequest,
            {
              ...secondPullRequest,
              snapshot: { state: "merged", mergedAt: "2026-10-17T11:30:00.000Z" },
            },
          ]);
          return { event: "pr.merged", threadId: "task-1", at: "2026-10-17T11:30:00.000Z" };
        }
        throw stop;
      },
    });

    await test.run({
      threadId: "task-1",
      condition: {
        type: "all",
        conditions: [
          { type: "pullRequestsMergedAndLive" },
          { type: "date", at: "2026-10-17T11:00:00.000Z" },
        ],
      },
      expectedGeneration: 4,
      at: "2026-10-17T10:00:00.000Z",
    });

    expect(test.agents).toHaveLength(2);
    expect(test.timeline.indexOf("call:complete")).toBeGreaterThan(
      test.timeline.lastIndexOf("agent"),
    );
    expect(test.agents.map((agent) => String(agent.prompt))).toEqual([
      expect.stringContaining("/pull/42"),
      expect.stringContaining("/pull/43"),
    ]);
  });

  it("keeps waiting when a pull request is linked while another is being verified", async () => {
    const stop = new Error("still waiting");
    let waits = 0;
    const test = fixture({
      verification: [{ state: "unknown", evidence: "Production check still running." }],
      wait: (label) => {
        waits++;
        if (label !== "Wait for deployment evidence") throw stop;
        // PR 43 is linked, still open, while PR 42's deployment is being proven.
        test.setPullRequests([
          mergedPullRequest,
          { ...unmergedPullRequest, number: 43, url: "https://github.com/example/project/pull/43" },
        ]);
        test.setVerificationText(
          JSON.stringify({
            state: "live",
            commit: COMMIT,
            evidence: "Production smoke check passed.",
          }),
        );
        return { event: "turn.finished", threadId: "verification-1" };
      },
    });

    await expect(
      test.run({
        threadId: "task-1",
        condition: {
          type: "all",
          conditions: [
            { type: "pullRequestsMergedAndLive" },
            { type: "date", at: "2026-10-17T11:00:00.000Z" },
          ],
        },
        expectedGeneration: 4,
        at: "2026-10-17T10:00:00.000Z",
      }),
    ).rejects.toBe(stop);
    expect(waits).toBe(2);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(false);
  });

  it("does not archive while a newly linked pull request is still open", async () => {
    const stop = new Error("still waiting");
    let waits = 0;
    const test = fixture({
      wait: () => {
        waits++;
        if (waits > 1) throw stop;
        test.setPullRequests([
          mergedPullRequest,
          { ...unmergedPullRequest, number: 43, url: "https://github.com/example/project/pull/43" },
        ]);
        return null;
      },
    });

    await expect(
      test.run({
        threadId: "task-1",
        condition: {
          type: "all",
          conditions: [
            { type: "pullRequestsMergedAndLive" },
            { type: "date", at: "2026-10-17T11:00:00.000Z" },
          ],
        },
        expectedGeneration: 4,
        at: "2026-10-17T10:00:00.000Z",
      }),
    ).rejects.toBe(stop);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(false);
  });

  it("proposes nothing, quietly, where model steps can't run", async () => {
    const test = fixture({ pullRequests: [], modelSteps: false });

    await expect(test.run({ threadId: "task-1", event: "thread.created" })).resolves.toBe(
      "No done-condition proposed: model steps can't run here yet.",
    );
    expect(test.llmCalls).toEqual([]);
    expect(test.calls.map((call) => call.args.action)).toEqual(["read"]);
  });

  it("still proposes and verifies the merged-PR condition where model steps can't run", async () => {
    const test = fixture({ modelSteps: false, verification: [{ state: "live" }] });
    await test.run({ threadId: "task-1", event: "thread.created" });
    expect(test.llmCalls).toEqual([]);
    expect(test.agents).toHaveLength(1);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(true);
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
    const test = fixture({
      unsettledAt: "2026-10-17T09:00:00.000Z",
      otherThreads: { "source-task": { archivedAt: "2026-10-17T10:00:00.000Z" } },
    });

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

  it("does not satisfy a date from before the task was reopened", async () => {
    const test = fixture({ unsettledAt: "2026-10-17T11:00:00.000Z" });

    const result = await test.run({
      threadId: "task-1",
      condition: { type: "date", at: "2026-10-17T10:00:00.000Z" },
      expectedGeneration: 4,
      at: "2026-10-17T12:00:00.000Z",
    });

    expect(result).toBe("The done-condition did not hold before its wait ended.");
    expect(test.timeline).not.toContain("wait:Wait until the date condition");
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(false);
  });

  it("does not satisfy an already archived dependency from before the task was reopened", async () => {
    const waiting = new Error("expected workflow wait");
    const test = fixture({
      unsettledAt: "2026-10-17T11:00:00.000Z",
      otherThreads: { "source-task": { archivedAt: "2026-10-17T10:00:00.000Z" } },
      wait: () => {
        throw waiting;
      },
    });

    await expect(
      test.run({
        threadId: "task-1",
        condition: { type: "taskArchived", taskThreadId: "source-task" },
        expectedGeneration: 4,
      }),
    ).rejects.toBe(waiting);

    expect(test.waits).toHaveLength(1);
    expect(test.calls.some((call) => call.args.action === "complete")).toBe(false);
  });

  it("satisfies a date after the task was reopened", async () => {
    const test = fixture({ unsettledAt: "2026-10-17T11:00:00.000Z" });

    await test.run({
      threadId: "task-1",
      condition: { type: "date", at: "2026-10-17T12:00:00.000Z" },
      expectedGeneration: 4,
      at: "2026-10-17T10:00:00.000Z",
    });

    expect(test.timeline).toContain("wait:Wait until the date condition");
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
