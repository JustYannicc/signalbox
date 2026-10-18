import { CommandId, MessageId, ORCHESTRATION_V2_WS_METHODS, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { SIGNALBOX_THREAD_KINDS_WS_METHODS } from "@t3tools/contracts/signalboxThreadKinds";
import { TaskLifecycleResult } from "@t3tools/contracts/taskLifecycle";

import { makePullRequestThread, threadId } from "./pullRequestThreadTesting.ts";
import * as ScriptedProvider from "../thread/scriptedProvider.ts";

const userId = "user_1";
const decodeVerifierReply = Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type VerificationReply = {
  readonly state: "live" | "none" | "failed" | "unknown";
  readonly commit?: string;
  readonly evidence: string;
  readonly runId?: string;
};
const withVerificationReply = (proof: VerificationReply | VerificationReply[]) => {
  const replies = Array.isArray(proof) ? [...proof] : [proof];
  const scriptedReply = ScriptedProvider.scriptedReply;
  return vi.spyOn(ScriptedProvider, "scriptedReply").mockImplementation((prompt) => {
    if (!prompt.includes("This is a read-only verification task")) {
      // Streaming recomputes a reply, so advance only when the repair message reaches the task.
      if (prompt.startsWith("The merged task is not live.") && replies.length > 1) replies.shift();
      return scriptedReply(prompt);
    }
    const reply = replies[0]!;
    return JSON.stringify({
      runId: "123",
      ...reply,
      commit: reply.commit ?? prompt.match(/actual merge commit is ([a-f0-9]{40})/)?.[1],
    });
  });
};

const makeDeployedThread = (
  deployment: { status: string; conclusion: string | null } = {
    status: "completed",
    conclusion: "success",
  },
) => {
  const fixture = makePullRequestThread({
    more: (method, url) =>
      method === "GET" && url.pathname === "/repos/owner/repo/actions/runs/123"
        ? new Response(
            JSON.stringify({
              id: 123,
              html_url: "https://github.test/owner/repo/actions/runs/123",
              head_sha: fixture.github.pulls[0]?.headOid,
              head_branch: "main",
              event: "push",
              ...deployment,
            }),
            { headers: { "content-type": "application/json" } },
          )
        : null,
  });
  return fixture;
};

const taskRecord = (tool: (name: string, input: unknown) => Effect.Effect<unknown>) =>
  Effect.flatMap(
    tool("task_lifecycle", { action: "read" }),
    Schema.decodeUnknownEffect(TaskLifecycleResult),
  );

const compiledOf = (source: string) => {
  const result = compileForCloud(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.compiled;
};

describe("cloud Task done automation", () => {
  it.effect("keeps the evaluator waiting without GitHub and resumes after reconnecting", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    withVerificationReply({ state: "live", evidence: "Production smoke passed." });
    const { cloud, github, open, tool, getRun, run } = makeDeployedThread();
    return run(
      Effect.gen(function* () {
        yield* open;
        yield* cloud.settle;
        github.merge(1);
        yield* cloud.syncPullRequests(threadId);
        const user = cloud.userDirectory.forUser(userId);
        yield* user.disconnectGitHub();
        yield* cloud.settle;

        const waiting = yield* taskRecord(tool);
        const runId = waiting.record!.condition!.runId!;
        const evaluation = yield* getRun(runId);
        expect(evaluation.run).toMatchObject({ status: "running", error: null });
        expect(evaluation.steps).toContainEqual(
          expect.objectContaining({
            label: "Wait for merge evidence access",
            status: "waiting",
          }),
        );
        expect(evaluation.steps.some((step) => step.verb === "agent")).toBe(false);
        expect(waiting.thread.archivedAt).toBeNull();
        expect(waiting.record?.outcome).toBeNull();

        yield* user.beginGitHubConnect({
          grantId: "reconnect",
          returnTo: "http://localhost:8787/api/github/callback",
        });
        github.authorize(userId);
        yield* user.completeGitHubConnect("reconnect");
        yield* cloud.workflows.advance(60_001);
        yield* cloud.settle;

        const completed = yield* taskRecord(tool);
        expect(completed.record?.condition?.runId).toBe(runId);
        expect(completed.thread.archivedAt).not.toBeNull();
        expect(completed.record?.outcome).toContain("[Live at ");
        expect((yield* getRun(runId)).run.error).toBeNull();
      }),
    );
  });

  it.effect("unlink wakes a verifier wait and archives from the remaining live PR", () => {
    const scriptedReply = ScriptedProvider.scriptedReply;
    vi.spyOn(ScriptedProvider, "scriptedReply").mockImplementation((prompt) => {
      if (!prompt.includes("This is a read-only verification task")) return scriptedReply(prompt);
      return JSON.stringify({
        state: prompt.includes("/pull/2") ? "unknown" : "live",
        commit: prompt.match(/actual merge commit is ([a-f0-9]{40})/)?.[1],
        runId: "123",
        evidence: "Deployment verification result.",
      });
    });
    const { cloud, github, open, tool, getRun, run } = makeDeployedThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        github.pulls.push({ ...github.pulls[0]!, number: 2 });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.pull-request.link",
          commandId: CommandId.make("task-done-link-second-pr"),
          threadId,
          host: "github.test",
          repository: "owner/repo",
          number: 2,
          url: "https://github.test/owner/repo/pull/2",
          source: "manual",
        });
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;
        github.merge(1);
        github.merge(2);
        yield* cloud.forgetPullRequestPolls(threadId);
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;

        const waiting = yield* taskRecord(tool);
        const runId = waiting.record!.condition!.runId!;
        expect(waiting.thread.archivedAt).toBeNull();
        expect((yield* getRun(runId)).steps).toContainEqual(
          expect.objectContaining({
            label: "Wait for deployment evidence",
            status: "waiting",
          }),
        );

        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("task-done-unlink-second-pr"),
          threadId,
          host: "github.test",
          repository: "owner/repo",
          number: 2,
        });
        yield* cloud.settle;

        const completed = yield* taskRecord(tool);
        expect(completed.record?.condition?.runId).toBe(runId);
        expect(completed.thread.archivedAt).not.toBeNull();
        expect(completed.record?.outcome).toContain("[Live at ");
        expect((yield* getRun(runId)).run.error).toBeNull();
      }),
    );
  });

  it.effect.each(["deploy", "smoke"] as const)(
    "wakes the task agent once across workflow replays with the failed %s and deployment link",
    (failure) => {
      withVerificationReply([
        {
          state: failure === "deploy" ? "live" : "failed",
          evidence:
            failure === "deploy"
              ? "The verifier claimed success."
              : "Configured smoke returned HTTP 500.",
        },
        { state: "unknown", evidence: "Waiting for the repair deployment." },
      ]);
      const { cloud, github, open, tool, messages, run } = makeDeployedThread({
        status: "completed",
        conclusion: failure === "deploy" ? "failure" : "success",
      });
      return run(
        Effect.gen(function* () {
          const { rpc } = yield* open;
          yield* cloud.settle;
          github.merge(1);
          yield* cloud.syncPullRequests(threadId);
          yield* cloud.settle;

          const current = yield* taskRecord(tool);
          const conditionRunId = current.record?.condition?.runId;
          expect(conditionRunId).toBeTruthy();
          const evaluation = yield* cloud.inUser(
            userId,
            WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(conditionRunId!)),
          );
          expect(evaluation.run.error).toBeNull();
          expect(current.thread.archivedAt).toBeNull();
          expect(current.thread.settledAt).toBeNull();
          expect(current.record?.outcome).toBeNull();
          const transcript = yield* messages(rpc);
          expect(transcript).toContainEqual(
            expect.stringContaining(
              failure === "deploy"
                ? "Failed run: https://github.test/owner/repo/actions/runs/123"
                : "Configured smoke returned HTTP 500.",
            ),
          );
          expect(
            transcript.filter((text) => text.startsWith("The merged task is not live.")).length,
          ).toBe(1);
          expect(current.runs.length).toBeGreaterThan(0);
        }),
      );
    },
  );

  it.effect("proposes the linked default and archives only after a live verification", () => {
    withVerificationReply({
      state: "live",
      evidence: "Production deployment passed its read-only smoke check.",
    });
    const { cloud, github, open, tool, run } = makeDeployedThread();
    return run(
      Effect.gen(function* () {
        const { rpc, turn: commit } = yield* open;
        yield* cloud.settle;

        const proposed = yield* taskRecord(tool);
        expect(proposed.kind).toBe("task");
        expect(proposed.record).toMatchObject({
          condition: {
            summary: "Merged and live",
            input: { type: "pullRequestsMergedAndLive", defaultProposal: true },
          },
          outcome: null,
          settledAt: null,
        });

        github.merge(1);
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;

        const completed = yield* taskRecord(tool);
        expect(completed.record).toMatchObject({
          condition: proposed.record?.condition,
          outcome: `[Live at ${commit.slice(0, 12)}](https://github.test/owner/repo/actions/runs/123)`,
          settledAt: expect.any(String),
        });
        expect(completed.thread).toMatchObject({
          archivedAt: expect.anything(),
          settledAt: expect.anything(),
          pullRequests: [
            expect.objectContaining({ snapshot: expect.objectContaining({ state: "merged" }) }),
          ],
        });

        const automation = (yield* cloud.inUser(
          userId,
          WorkflowEngine.WorkflowEngine.use((engine) => engine.list()),
        )).find((candidate) => candidate.name === "Task done");
        expect(automation).toBeDefined();
        const detail = yield* cloud.inUser(
          userId,
          WorkflowEngine.WorkflowEngine.use((engine) => engine.get(automation!.id)),
        );
        const runs = yield* Effect.forEach(detail.runs, (entry) =>
          cloud.inUser(
            userId,
            WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(entry.id)),
          ),
        );
        const verifier = runs
          .flatMap((entry) => entry.steps)
          .find((step) => step.label === "Verify the merged work is live");
        expect(verifier).toMatchObject({
          verb: "agent",
          status: "succeeded",
        });
        const reply = yield* decodeVerifierReply(verifier?.result);
        expect(JSON.parse(reply.text)).toEqual({
          state: "live",
          commit,
          runId: "123",
          evidence: "Production deployment passed its read-only smoke check.",
        });
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId,
        });
        expect(projection.thread.archivedAt).not.toBeNull();
        expect(projection.thread.settledAt).not.toBeNull();
      }),
    );
  });

  it.effect("treats an affirmative no-deploy result as complete and records an outcome", () => {
    withVerificationReply({
      state: "none",
      evidence: "Repository configuration has no deployment.",
    });
    const { cloud, github, open, tool, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { turn: commit } = yield* open;
        yield* cloud.settle;
        github.merge(1);
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;

        const completed = yield* taskRecord(tool);
        expect(completed.record).toMatchObject({
          outcome: `Merged at ${commit.slice(0, 12)}`,
          settledAt: expect.any(String),
        });
        expect(completed.thread.archivedAt).not.toBeNull();
      }),
    );
  });

  it.effect("reopens on a new user message and does not rearchive from the old merged PR", () => {
    withVerificationReply({
      state: "none",
      evidence: "Repository configuration has no deployment.",
    });
    const { cloud, github, open, tool, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        yield* cloud.settle;
        github.merge(1);
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;

        const completed = yield* taskRecord(tool);
        expect(completed.thread.archivedAt).not.toBeNull();
        const previousCondition = completed.record?.condition;
        const previousGeneration = completed.record?.generation ?? 0;

        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "message.dispatch",
          commandId: CommandId.make("task-done-reopen-message"),
          threadId,
          messageId: MessageId.make("task-done-reopen-message"),
          text: "Please continue the work.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
        });
        yield* cloud.settle;

        const reopened = yield* taskRecord(tool);
        expect(reopened.record).toMatchObject({
          condition: {
            summary: previousCondition?.summary,
            input: previousCondition?.input,
          },
          outcome: null,
          settledAt: null,
          generation: expect.any(Number),
        });
        expect(reopened.record!.generation).toBeGreaterThan(previousGeneration);
        expect(reopened.thread.archivedAt).toBeNull();
        expect(reopened.thread.settledAt).toBeNull();

        // Re-link the same merged pull request so its old merge time is delivered after reopening.
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("task-done-unlink-old-pr"),
          threadId,
          host: "github.test",
          repository: "owner/repo",
          number: 1,
        });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.pull-request.link",
          commandId: CommandId.make("task-done-relink-old-pr"),
          threadId,
          host: "github.test",
          repository: "owner/repo",
          number: 1,
          url: "https://github.test/owner/repo/pull/1",
          source: "manual",
        });
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;

        const stillOpen = yield* taskRecord(tool);
        expect(stillOpen.thread.archivedAt).toBeNull();
        expect(stillOpen.thread.settledAt).toBeNull();
        expect(stillOpen.record?.outcome).toBeNull();
      }),
    );
  });

  it.effect("does not give chats a done-condition when a pull request is linked", () => {
    const { cloud, open, tool, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        yield* rpc[SIGNALBOX_THREAD_KINDS_WS_METHODS.setKind]({ threadId, kind: "chat" });
        yield* cloud.settle;

        const chat = yield* taskRecord(tool);
        expect(chat.kind).toBe("chat");
        expect(chat.record?.condition ?? null).toBeNull();
      }),
    );
  });

  it.effect("does not propose or archive new tasks when the project disables Task done", () => {
    const { cloud, open, tool, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        yield* cloud.settle;

        const first = yield* taskRecord(tool);
        expect(first.record?.condition).not.toBeNull();
        const automation = (yield* cloud.inUser(
          userId,
          WorkflowEngine.WorkflowEngine.use((engine) => engine.list()),
        )).find((candidate) => candidate.name === "Task done");
        expect(automation?.enabled).toBe(true);
        expect(automation?.projectId).toBe(first.thread.projectId);

        yield* cloud.inUser(
          userId,
          WorkflowEngine.WorkflowEngine.use((engine) =>
            Effect.gen(function* () {
              yield* engine.cancelAttached(threadId);
              yield* engine.setEnabled(automation!.id, false);
            }),
          ),
        );

        const nextThreadId = ThreadId.make("task-done-disabled-default");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make("task-done-disabled-default-launch"),
          threadId: nextThreadId,
          projectId: first.thread.projectId,
          title: "Another task",
          modelSelection: first.thread.modelSelection,
          runtimeMode: first.thread.runtimeMode,
          interactionMode: first.thread.interactionMode,
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make("task-done-disabled-default-message"),
            text: "Finish this task",
            attachments: [],
          },
        });
        yield* cloud.settle;

        const next = yield* cloud.inUser(
          userId,
          WorkflowEngine.WorkflowEngine.use((engine) =>
            engine.taskLifecycle({ threadId: nextThreadId, action: "read" }),
          ),
        );
        expect(next.kind).toBe("task");
        expect(next.record?.condition ?? null).toBeNull();
        expect(next.thread.archivedAt).toBeNull();

        const stillDisabled = yield* cloud.inUser(
          userId,
          WorkflowEngine.WorkflowEngine.use((engine) => engine.get(automation!.id)),
        );
        expect(stillDisabled.automation.enabled).toBe(false);
      }),
    );
  });

  it.effect(
    "keeps a customized Task done source and disabled state when thread events arrive",
    () => {
      const { cloud, open, tool, run } = makePullRequestThread();
      return run(
        Effect.gen(function* () {
          const { rpc } = yield* open;
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId,
          });
          const projectId = projection.thread.projectId;
          const defaults = {
            modelSelection: projection.thread.modelSelection,
            runtimeMode: projection.thread.runtimeMode,
            interactionMode: projection.thread.interactionMode,
          };
          const customSource = `export const meta = {
  name: "Task done",
  description: "A project-owned completion policy.",
  triggers: [],
} as const;

export default workflow(async (w) => {
  return "custom policy";
});
`;

          const customized = yield* cloud.inUser(
            userId,
            WorkflowEngine.WorkflowEngine.use((engine) =>
              engine.customize("builtin:task-done", { projectId, defaults }),
            ),
          );
          yield* tool("automation_save", {
            automationId: customized.id,
            source: customSource,
            compiled: compiledOf(customSource),
          });
          yield* cloud.inUser(
            userId,
            WorkflowEngine.WorkflowEngine.use((engine) => engine.setEnabled(customized.id, false)),
          );

          yield* cloud.settle;

          const detail = yield* cloud.inUser(
            userId,
            WorkflowEngine.WorkflowEngine.use((engine) => engine.get(customized.id)),
          );
          expect(detail.source).toBe(customSource);
          expect(detail.automation.enabled).toBe(false);
          expect(detail.runs).toHaveLength(0);
          const task = yield* taskRecord(tool);
          expect(task.record?.condition ?? null).toBeNull();
        }),
      );
    },
  );
});
