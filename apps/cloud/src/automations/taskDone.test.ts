import { CommandId, MessageId, ORCHESTRATION_V2_WS_METHODS, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { FakeWorkflows } from "@signalbox/automations/workflow/testing";
import { SIGNALBOX_THREAD_KINDS_WS_METHODS } from "@t3tools/contracts/signalboxThreadKinds";
import { TaskLifecycleResult } from "@t3tools/contracts/taskLifecycle";

import { makePullRequestThread, threadId } from "./pullRequestThreadTesting.ts";
import * as CloudBuiltinTools from "./cloudBuiltinTools.ts";
import * as ScriptedProvider from "../thread/scriptedProvider.ts";

const userId = "user_1";
const decodeVerifierReply = Schema.decodeUnknownEffect(
  Schema.Struct({ text: Schema.String, threadId: Schema.String }),
);

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
  it.effect(
    "keeps a verifier follow-up that finishes before the worker reads its initial reply",
    () => {
      const proof: { state: VerificationReply["state"]; evidence: string } = {
        state: "unknown",
        evidence: "Production access is missing. Please supply it here.",
      };
      withVerificationReply(proof);
      const { cloud, github, open, tool, getRun, run } = makeDeployedThread();
      const reached = Promise.withResolvers<void>();
      const isVerifierResult = Schema.is(
        Schema.Struct({ text: Schema.String, threadId: Schema.String }),
      );
      const sendEvent = FakeWorkflows.prototype.sendEvent;
      let release: (() => void) | undefined;
      vi.spyOn(FakeWorkflows.prototype, "sendEvent").mockImplementation(function (
        this: FakeWorkflows,
        type,
        settlement,
      ) {
        if (!release && settlement.ok && isVerifierResult(settlement.value)) {
          // The host has stored the initial reply; delay its delivery to the compiled worker.
          release = () => sendEvent.call(this, type, settlement);
          reached.resolve();
          return;
        }
        sendEvent.call(this, type, settlement);
      });
      return run(
        Effect.gen(function* () {
          const { rpc, turn: commit } = yield* open;
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "message.dispatch",
            commandId: CommandId.make("task-done-early-follow-up-request"),
            threadId,
            messageId: MessageId.make("task-done-early-follow-up-request"),
            text: "Finish this useful task.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
          });
          yield* cloud.settle;
          github.merge(1);
          yield* cloud.syncPullRequests(threadId);
          yield* cloud.settle;
          yield* Effect.promise(() => reached.promise);
          const waiting = yield* taskRecord(tool);
          const heldRunId = waiting.record!.condition!.runId!;
          let verifierId = "";
          try {
            const evaluation = yield* getRun(heldRunId!);
            const verifier = yield* decodeVerifierReply(
              evaluation.steps.find((step) => step.label === "Verify the merged work is live")!
                .result,
            );
            verifierId = verifier.threadId;
            expect(JSON.parse(verifier.text).state).toBe("unknown");
            proof.state = "live";
            proof.evidence = "Production smoke passed.";
            yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "message.dispatch",
              commandId: CommandId.make("task-done-early-verifier-follow-up"),
              threadId: ThreadId.make(verifierId),
              messageId: MessageId.make("task-done-early-verifier-follow-up"),
              text: `This is a read-only verification task. The actual merge commit is ${commit}. Access is supplied; check again.`,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
              deliveryIntent: "auto",
            });
            yield* cloud.settleThreads;
            yield* cloud.inUser(
              userId,
              WorkflowEngine.WorkflowEngine.use((engine) => engine.drain),
            );
            const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: ThreadId.make(verifierId),
            });
            const reply = projection.messages.findLast((message) => message.role === "assistant")!;
            expect(JSON.parse(reply.text)).toMatchObject({ state: "live", commit });
          } finally {
            release!();
          }
          yield* cloud.settle;

          const completed = yield* taskRecord(tool);
          expect(completed.record?.condition?.runId).toBe(heldRunId);
          expect(completed.thread.archivedAt).not.toBeNull();
          expect(completed.record?.outcome).toContain("[Live at ");
          const evaluation = yield* getRun(heldRunId!);
          expect(evaluation.steps).toContainEqual(
            expect.objectContaining({
              label: "Wait for deployment evidence",
              status: "succeeded",
              result: expect.objectContaining({ event: "turn.finished", threadId: verifierId }),
            }),
          );
          expect(evaluation.run.error).toBeNull();
        }),
      );
    },
  );

  it.effect.each(["evidence", "repair"] as const)(
    "keeps a queued turn finish after a PR wake during the %s wait",
    (phase) => {
      const proof: { state: VerificationReply["state"]; evidence: string } = {
        state: phase === "evidence" ? "unknown" : "failed",
        evidence: "The production check is not passing yet.",
      };
      withVerificationReply(proof);
      if (phase === "repair") {
        // Real notifications re-arm the evaluator; agent-wake tests cover that separately.
        const makeTools = CloudBuiltinTools.makeCloudBuiltinTools;
        vi.spyOn(CloudBuiltinTools, "makeCloudBuiltinTools").mockImplementation((deps) => {
          const tools = makeTools(deps);
          return {
            ...tools,
            call: (call) =>
              call.tool === "t3_thread_send"
                ? Effect.succeed({ delivery: "queued" })
                : tools.call(call),
          };
        });
      }
      const { cloud, github, open, tool, getRun, run } = makeDeployedThread();
      const reached = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const forUser = cloud.userDirectory.forUser;
      let heldRunId: string | undefined;
      vi.spyOn(cloud.userDirectory, "forUser").mockImplementation((id) => {
        const user = forUser(id);
        return {
          ...user,
          automationHost: (call) =>
            Effect.gen(function* () {
              const answer = yield* user.automationHost(call);
              if (
                !heldRunId &&
                call.method === "step" &&
                call.args[1].label ===
                  (phase === "evidence"
                    ? "Wait for deployment evidence"
                    : "Wait for the deployment repair")
              ) {
                const key = call.args[1].key;
                const detail = yield* getRun(call.args[0]);
                // Let an already-buffered initial verifier finish be consumed before injecting the race.
                if (detail.steps.find((step) => step.key === key)?.status === "waiting") {
                  heldRunId = call.args[0];
                  reached.resolve();
                  yield* Effect.promise(() => resume.promise);
                }
              }
              return answer;
            }),
        };
      });
      return run(
        Effect.gen(function* () {
          const { rpc, turn: commit } = yield* open;
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "message.dispatch",
            commandId: CommandId.make("task-done-race-request"),
            threadId,
            messageId: MessageId.make("task-done-race-request"),
            text: "Finish this useful task.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
          });
          yield* cloud.settle;
          github.merge(1);
          yield* cloud.syncPullRequests(threadId);
          const settling = yield* Effect.forkChild(cloud.settle);
          yield* Effect.promise(() => reached.promise);
          try {
            const waiting = yield* taskRecord(tool);
            expect(heldRunId).toBe(waiting.record?.condition?.runId);
            const evaluation = yield* getRun(heldRunId!);
            const verifier = yield* decodeVerifierReply(
              evaluation.steps.find((step) => step.label === "Verify the merged work is live")!
                .result,
            );
            // The real inbox must consume the PR event first and retain the following turn.
            yield* cloud.inUser(
              userId,
              WorkflowEngine.WorkflowEngine.use((engine) =>
                engine.deliverEvent({
                  event: "pr.updated",
                  id: `task-done-${phase}-race`,
                  at: "2026-10-18T10:00:00.000Z",
                  projectId: waiting.thread.projectId,
                  threadId,
                  fields: Effect.succeed({}),
                }),
              ),
            );
            proof.state = "live";
            proof.evidence = "Production smoke passed.";
            if (phase === "evidence") {
              yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "message.dispatch",
                commandId: CommandId.make("task-done-verifier-race-reply"),
                threadId: ThreadId.make(verifier.threadId),
                messageId: MessageId.make("task-done-verifier-race-reply"),
                text: `This is a read-only verification task. The actual merge commit is ${commit}. Check again.`,
                attachments: [],
                createdBy: "user",
                creationSource: "web",
                dispatchMode: { type: "start_immediately" },
                deliveryIntent: "auto",
              });
            } else {
              yield* cloud.inUser(
                userId,
                WorkflowEngine.WorkflowEngine.use((engine) =>
                  engine.deliverEvent({
                    event: "turn.finished",
                    id: "task-done-repair-finished",
                    at: "2026-10-18T10:00:00.000Z",
                    projectId: waiting.thread.projectId,
                    threadId,
                    fields: Effect.succeed({ status: "completed" }),
                  }),
                ),
              );
            }
            yield* cloud.settleThreads;
          } finally {
            resume.resolve();
          }
          yield* Fiber.join(settling);
          yield* cloud.settle;

          const completed = yield* taskRecord(tool);
          expect(completed.record?.condition?.runId).toBe(heldRunId);
          expect(completed.thread.archivedAt).not.toBeNull();
          expect(completed.record?.outcome).toContain("[Live at ");
          const evaluation = yield* getRun(heldRunId!);
          const label =
            phase === "evidence"
              ? "Wait for deployment evidence"
              : "Wait for the deployment repair";
          expect(
            evaluation.steps
              .filter((step) => step.label === label)
              .slice(-2)
              .map((step) => step.result),
          ).toEqual([
            expect.objectContaining({ event: "pr.updated", threadId }),
            expect.objectContaining({ event: "turn.finished" }),
          ]);
          expect(evaluation.run.error).toBeNull();
        }),
      );
    },
  );

  it.effect("ignores unrelated project events and ends the evidence wait on task archival", () => {
    withVerificationReply({ state: "unknown", evidence: "Production access is missing." });
    const { cloud, github, open, tool, getRun, run } = makeDeployedThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        yield* cloud.settle;
        github.merge(1);
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;
        const waiting = yield* taskRecord(tool);
        const runId = waiting.record!.condition!.runId!;
        const before = yield* getRun(runId);
        for (const event of ["pr.updated", "turn.finished", "thread.archived"] as const) {
          yield* cloud.inUser(
            userId,
            WorkflowEngine.WorkflowEngine.use((engine) =>
              engine.deliverEvent({
                event,
                id: `unrelated-${event}`,
                at: "2026-10-18T10:00:00.000Z",
                projectId: waiting.thread.projectId,
                threadId: "unrelated-task",
                fields: Effect.succeed({}),
              }),
            ),
          );
          yield* cloud.settle;
        }
        expect((yield* getRun(runId)).steps).toHaveLength(before.steps.length);
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.archive",
          commandId: CommandId.make("task-done-archive-during-verification"),
          threadId,
        });
        yield* cloud.settle;
        const archived = yield* taskRecord(tool);
        expect(archived.thread.archivedAt).not.toBeNull();
        expect(archived.record?.outcome).toBeNull();
        expect((yield* getRun(runId)).run.status).not.toBe("running");
      }),
    );
  });

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
