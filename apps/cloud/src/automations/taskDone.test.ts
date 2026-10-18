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
const commit = "a".repeat(40);

afterEach(() => vi.restoreAllMocks());

const withVerificationReply = (proof: {
  readonly state: "live" | "none" | "failed" | "unknown";
  readonly commit: string;
  readonly evidence: string;
}) => {
  const scriptedReply = ScriptedProvider.scriptedReply;
  return vi
    .spyOn(ScriptedProvider, "scriptedReply")
    .mockImplementation((prompt) =>
      prompt.includes("This is a read-only verification task")
        ? JSON.stringify(proof)
        : scriptedReply(prompt),
    );
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
  it.effect("proposes the linked default and archives only after a live verification", () => {
    withVerificationReply({
      state: "live",
      commit,
      evidence: "Production deployment passed its read-only smoke check.",
    });
    const { cloud, github, open, tool, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
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
          outcome: `Live at ${commit.slice(0, 12)}`,
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
          result: {
            text: JSON.stringify({
              state: "live",
              commit,
              evidence: "Production deployment passed its read-only smoke check.",
            }),
          },
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
      commit,
      evidence: "Repository configuration has no deployment.",
    });
    const { cloud, github, open, tool, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        yield* open;
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
      commit,
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
