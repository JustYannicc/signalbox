import {
  CommandId,
  EnvironmentId,
  NodeId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderTurn,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2RuntimeRequest,
  ProviderTurnId,
  RunAttemptId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import * as Platform from "../platform.ts";
import { layerAttachments, layerPersonalThreadContexts, makeMemoryCloud } from "../testing.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import * as Threads from "./Threads.ts";
import * as ThreadsLive from "./ThreadsLive.ts";
import { pushFor } from "../push/pushRules.ts";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { unsupported } from "./threadDecider.ts";
import { nodeEvent, runEvent, runtimeRequestEvent, turnItemEvent } from "./threadEvents.ts";
import { threadShellFromProjection } from "./threadProjection.ts";
import {
  approvalRequestEvents,
  isCloudApprovalRequest,
  requestItemId,
  respondToRuntimeRequest,
  runtimeRequestContext,
  runtimeResponses,
} from "./runtimeRequests.ts";
import { ThreadStore } from "./ThreadStore.ts";
import { ThreadSecretRequests } from "./ThreadSecrets.ts";
import {
  connect,
  freshDatabase,
  hello,
  launch,
  liveTurn,
  owner,
  personal,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "./runnerTesting.ts";

const requestId = RuntimeRequestId.make("native-request-1");
const encodeRequest = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2RuntimeRequest));
const encodeNode = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ExecutionNode));
const encodeItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));

const contextForAttempt = (
  projection: OrchestrationV2ThreadProjection,
  request: OrchestrationV2RuntimeRequest,
  runAttemptId: RunAttemptId,
) => {
  const node = projection.nodes.find((candidate) => candidate.id === request.nodeId)!;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === node.providerThreadId,
  )!;
  return runtimeRequestContext(
    {
      ...projection,
      providerTurns: [
        {
          id: ProviderTurnId.make("native-request-turn"),
          providerThreadId: providerThread.id,
          nodeId: node.id,
          runAttemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: projection.updatedAt,
          completedAt: null,
        } satisfies OrchestrationV2ProviderTurn,
      ],
    },
    { ...request, providerTurnId: ProviderTurnId.make("native-request-turn") },
  );
};

const waiting = (
  engine: Parameters<typeof launch>[0],
  runner: Parameters<typeof connect>[0],
  kind: "user_input" | "command" = "user_input",
  message = false,
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const machine = yield* connect(runner);
    const turn = yield* liveTurn(runner);
    const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
    yield* runner.batch({ generation: machine.generation, sequence: 1, items: [report.started] });
    const before = (yield* snapshot(engine)).projection;
    const root = before.nodes.find((node) => node.id === turn.rootNodeId)!;
    const node = {
      ...root,
      id: NodeId.make("question-node"),
      parentNodeId: root.id,
      kind: kind === "user_input" ? ("user_input_request" as const) : ("approval_request" as const),
      status: "waiting" as const,
      runtimeRequestId: requestId,
    };
    yield* engine.apply(() =>
      Effect.succeed({
        events: [
          nodeEvent({ now: before.updatedAt }, node),
          turnItemEvent(
            { now: before.updatedAt },
            {
              id: TurnItemId.make("question-item"),
              requestId,
              threadId,
              runId: turn.runId,
              nodeId: node.id,
              providerThreadId: turn.providerThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1_000_001,
              status: "waiting",
              title: null,
              startedAt: before.updatedAt,
              completedAt: null,
              updatedAt: before.updatedAt,
              ...(kind === "user_input"
                ? {
                    type: "user_input_request" as const,
                    questions: [
                      { id: "choice", header: "Colour", question: "Which colour?", options: [] },
                    ],
                    ...(message ? { responseMode: "message" as const } : {}),
                  }
                : {
                    type: "approval_request" as const,
                    requestKind: "command" as const,
                    prompt: "Run printf proof?",
                  }),
            },
          ),
        ],
        result: undefined,
      }),
    );
    const request: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId: node.id,
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      status: "pending",
      responseCapability: message
        ? { type: "message" }
        : { type: "live", providerSessionId: report.started.providerSession.id },
      createdAt: before.updatedAt,
      resolvedAt: null,
    };
    const item = {
      kind: "provider" as const,
      runId: turn.runId,
      event: { type: "runtime_request.updated", runtimeRequest: encodeRequest(request) },
    };
    yield* runner.batch({ generation: machine.generation, sequence: 2, items: [item] });
    return { before, machine, turn, report, item };
  });

const answer = (commandId = "answer-1") => ({
  type: "runtime-request.respond" as const,
  commandId: CommandId.make(commandId),
  threadId,
  requestId,
  answers: { choice: "Blue" },
});

const sendApprovalEvents = (
  projection: OrchestrationV2ThreadProjection,
  runId: string,
  requestId: RuntimeRequestId,
) => {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) throw new Error("The approval run was not found.");
  const events = approvalRequestEvents(
    projection,
    run,
    {
      requestId,
      title: "Send a secret?",
      prompt: "An agent wants to send KEY to hooks.example.test.",
      appName: "Secrets",
      options: [
        { decision: "decline", label: "Don't send" },
        { decision: "acceptAlways", label: "Always send to hooks.example.test" },
        { decision: "accept", label: "Send this turn" },
      ],
    },
    { now: projection.updatedAt },
  );
  if (events === null) throw new Error("The live run could not ask for an egress approval.");
  return events;
};

describe("cloud native runtime requests", () => {
  it.effect.each([false, true])(
    "preserves an answer for retry when the legacy machine's update attempt is %s",
    (runtimeResponsesUpgrade) =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* waiting(engine, runner);
          const store = Context.get(context, ThreadStore);
          const capable = yield* store.machine;
          yield* store.saveMachine({
            ...capable,
            runtimeResponses: false,
            runtimeResponsesUpgrade,
          });
          const before = yield* snapshot(engine);
          const refused = yield* Effect.result(engine.dispatch(owner, answer(), personal));
          expect(refused).toMatchObject({
            _tag: "Failure",
            failure: {
              message: runtimeResponsesUpgrade
                ? "This machine couldn't update to support questions and approvals. Stop this turn and wait for the machine to shut down before retrying."
                : "This machine is updating. Try your answer again shortly.",
            },
          });
          expect((yield* snapshot(engine)).head).toBe(before.head);
          expect((yield* snapshot(engine)).projection.runtimeRequests[0]?.status).toBe("pending");
          yield* store.saveMachine(capable);
          yield* engine.dispatch(owner, answer(), personal);
          expect((yield* runner.work).runtimeResponses).toMatchObject([
            { requestId, answers: { choice: "Blue" } },
          ]);
        }),
      ),
  );

  it.effect.each(["user_input", "command"] as const)(
    "keeps a live %s request resumable from a conflict helper",
    (kind) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* waiting(engine, runner, kind);
          const projection = (yield* snapshot(engine)).projection;
          const request = projection.runtimeRequests.find(
            (candidate) => candidate.id === requestId,
          )!;
          const attempt = projection.attempts.find(
            (candidate) => candidate.id === projection.runs[0]?.activeAttemptId,
          )!;

          expect(
            contextForAttempt(projection, request, RunAttemptId.make(`${attempt.id}:sync:1`)),
          ).not.toBeNull();
        }),
      ),
  );

  it.effect("rejects unrelated and malformed provider attempt identities", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* waiting(engine, runner);
        const projection = (yield* snapshot(engine)).projection;
        const request = projection.runtimeRequests.find((candidate) => candidate.id === requestId)!;
        const attempt = projection.attempts.find(
          (candidate) => candidate.id === projection.runs[0]?.activeAttemptId,
        )!;

        expect(contextForAttempt(projection, request, attempt.id)).not.toBeNull();
        expect(
          contextForAttempt(projection, request, RunAttemptId.make(`${attempt.id}:merge:2`)),
        ).not.toBeNull();
        for (const invalid of [
          "other-run:sync:1",
          `${attempt.id}:sync:0`,
          `${attempt.id}:sync:01`,
          `${attempt.id}:rebase:1`,
          `${attempt.id}:merge:1:2`,
        ]) {
          expect(contextForAttempt(projection, request, RunAttemptId.make(invalid))).toBeNull();
        }

        const staleTurnId = ProviderTurnId.make("stale-native-request-turn");
        const node = projection.nodes.find((candidate) => candidate.id === request.nodeId)!;
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === node.providerThreadId,
        )!;
        const staleProjection = {
          ...projection,
          runtimeRequests: projection.runtimeRequests.map((candidate) =>
            candidate.id === request.id ? { ...candidate, providerTurnId: staleTurnId } : candidate,
          ),
          providerTurns: [
            {
              id: staleTurnId,
              providerThreadId: providerThread.id,
              nodeId: request.nodeId,
              runAttemptId: RunAttemptId.make("other-run:sync:1"),
              nativeTurnRef: null,
              ordinal: 1,
              status: "running" as const,
              startedAt: projection.updatedAt,
              completedAt: null,
            } satisfies OrchestrationV2ProviderTurn,
          ],
        };
        expect(
          respondToRuntimeRequest(
            staleProjection,
            { ...answer("answer-stale-attempt"), requestId: request.id },
            { now: projection.updatedAt },
          ),
        ).toMatchObject({
          _tag: "rejected",
          message: "This request's turn has ended or been replaced.",
        });
      }),
    ),
  );

  it.effect.each([false, true])(
    "answers cloud egress approvals during a legacy runtime-response upgrade (%s)",
    (runtimeResponsesUpgrade) =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          const { turn } = yield* waiting(engine, runner);
          const store = Context.get(context, ThreadStore);
          const machine = yield* store.machine;
          yield* store.saveMachine({
            ...machine,
            runtimeResponses: false,
            runtimeResponsesUpgrade,
          });

          const before = (yield* snapshot(engine)).projection;
          const run = before.runs.find((candidate) => candidate.id === turn.runId)!;
          const sendRequestId = RuntimeRequestId.make(
            `runtime-request:secret-send:${turn.runId}:1`,
          );
          const events = sendApprovalEvents(before, turn.runId, sendRequestId);
          yield* engine.apply(() => Effect.succeed({ events, result: undefined }));

          const pending = (yield* snapshot(engine)).projection;
          const sendRequest = pending.runtimeRequests.find(
            (candidate) => candidate.id === sendRequestId,
          )!;
          const nativeRequest = pending.runtimeRequests.find(
            (candidate) => candidate.id === requestId,
          )!;
          const root = pending.nodes.find((node) => node.id === run.rootNodeId)!;
          expect(isCloudApprovalRequest(pending, sendRequest)).toBe(true);
          expect(isCloudApprovalRequest(pending, nativeRequest)).toBe(false);
          expect(runtimeResponses(pending, turn.runId)).toEqual([]);

          yield* engine.dispatch(
            owner,
            {
              type: "runtime-request.respond",
              commandId: CommandId.make("answer-egress"),
              threadId,
              requestId: sendRequestId,
              decision: "accept",
            },
            personal,
          );

          const answered = (yield* snapshot(engine)).projection;
          expect(
            answered.runtimeRequests.find((candidate) => candidate.id === sendRequestId),
          ).toMatchObject({
            status: "resolved",
            decision: "accept",
          });
          expect(
            answered.runtimeRequests.find((candidate) => candidate.id === requestId)?.status,
          ).toBe("pending");
          expect(answered.nodes.find((node) => node.id === root.id)).toEqual(root);
          expect(runtimeResponses(answered, turn.runId)).toEqual([]);
          expect((yield* runner.work).runtimeResponses).toEqual([]);
        }),
      ),
  );

  it.effect.each(["native-first", "cloud-first"] as const)(
    "resumes after both native and cloud approvals are answered (%s)",
    (answerOrder) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { turn } = yield* waiting(engine, runner);
          const before = (yield* snapshot(engine)).projection;
          const cloudRequestId = RuntimeRequestId.make(`cloud-approval:${answerOrder}`);
          yield* engine.apply(() =>
            Effect.succeed({
              events: sendApprovalEvents(before, turn.runId, cloudRequestId),
              result: undefined,
            }),
          );

          const answerNative = () =>
            engine.dispatch(owner, answer(`answer-native-${answerOrder}`), personal);
          const answerCloud = () =>
            engine.dispatch(
              owner,
              {
                type: "runtime-request.respond",
                commandId: CommandId.make(`answer-cloud-${answerOrder}`),
                threadId,
                requestId: cloudRequestId,
                decision: "accept",
              },
              personal,
            );
          if (answerOrder === "native-first") {
            yield* answerNative();
            expect((yield* snapshot(engine)).projection.runs[0]?.status).toBe("waiting");
            yield* answerCloud();
          } else {
            yield* answerCloud();
            expect((yield* snapshot(engine)).projection.runs[0]?.status).toBe("waiting");
            yield* answerNative();
          }

          const answered = (yield* snapshot(engine)).projection;
          expect(answered.runs.find((candidate) => candidate.id === turn.runId)?.status).toBe(
            "running",
          );
          expect(answered.runtimeRequests).toMatchObject([
            { id: requestId, status: "resolved" },
            { id: cloudRequestId, status: "resolved" },
          ]);
          expect(
            runtimeResponses(answered, turn.runId).map((response) => response.requestId),
          ).toEqual([requestId]);
        }),
      ),
  );

  it.effect("keeps a run waiting for a private request after cloud approval is answered", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const { turn, machine } = yield* waiting(engine, runner);
        const secrets = Context.get(context, ThreadSecretRequests);
        const privateRequestId = TurnItemId.make(
          `turn-item:secret-request:${turn.runId}:coexisting-private`,
        );
        const privateWaiter = yield* secrets
          .request(machine.generation, {
            runId: turn.runId,
            attemptId: turn.attemptId,
            input: {
              clientRequestId: "coexisting-private",
              label: "Private value",
              reason: "Configure a webhook.",
            },
          })
          .pipe(Effect.forkChild);
        const stream = yield* engine.subscribe(owner, { threadId });
        const pendingPrivate = yield* stream.pipe(
          Stream.mapEffect(() => engine.projection),
          Stream.filter(
            (projection) =>
              projection?.turnItems.some((item) => item.id === privateRequestId) === true,
          ),
          Stream.runHead,
        );
        expect(Option.isSome(pendingPrivate)).toBe(true);
        const before = (yield* snapshot(engine)).projection;
        const cloudRequestId = RuntimeRequestId.make("cloud-approval-with-private-request");
        yield* engine.apply(() =>
          Effect.succeed({
            events: sendApprovalEvents(before, turn.runId, cloudRequestId),
            result: undefined,
          }),
        );
        yield* engine.dispatch(owner, answer("answer-native-with-private"), personal);
        yield* engine.dispatch(
          owner,
          {
            type: "runtime-request.respond",
            commandId: CommandId.make("answer-cloud-with-private"),
            threadId,
            requestId: cloudRequestId,
            decision: "accept",
          },
          personal,
        );
        const answered = (yield* snapshot(engine)).projection;
        expect(answered.runs.find((candidate) => candidate.id === turn.runId)?.status).toBe(
          "waiting",
        );
        expect(answered.turnItems.find((item) => item.id === privateRequestId)).toMatchObject({
          secretStatus: "pending",
        });
        yield* secrets.answer(owner, {
          threadId,
          turnItemId: privateRequestId,
          answer: { type: "decline" },
        });
        expect(yield* Fiber.join(privateWaiter)).toEqual({ status: "declined" });
        expect(
          (yield* snapshot(engine)).projection.runs.find((run) => run.id === turn.runId)?.status,
        ).toBe("running");
      }),
    ),
  );

  it.effect("answers a native root approval with the exact attempt and session in its outbox", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started],
        });

        const before = (yield* snapshot(engine)).projection;
        const root = before.nodes.find((node) => node.id === turn.rootNodeId)!;
        const attempt = before.attempts.find(
          (candidate) => candidate.id === before.runs[0]?.activeAttemptId,
        )!;
        const nativeRootRequestId = RuntimeRequestId.make("native-root-approval");
        const request: OrchestrationV2RuntimeRequest = {
          id: nativeRootRequestId,
          nodeId: root.id,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "permission",
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: report.started.providerSession.id,
          },
          createdAt: before.updatedAt,
          resolvedAt: null,
        };
        const nativeItem: OrchestrationV2TurnItem = {
          id: TurnItemId.make(`turn-item:runtime-request:${nativeRootRequestId}`),
          requestId: nativeRootRequestId,
          threadId,
          runId: turn.runId,
          nodeId: root.id,
          providerThreadId: turn.providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1_000_001,
          status: "waiting",
          title: "Native approval",
          startedAt: before.updatedAt,
          completedAt: null,
          updatedAt: before.updatedAt,
          type: "approval_request",
          requestKind: "permission",
          prompt: "Approve the native request?",
          appName: "Codex",
          options: [{ decision: "accept", label: "Allow" }],
        };
        yield* engine.apply(() =>
          Effect.succeed({
            events: [
              nodeEvent(
                { now: before.updatedAt },
                { ...root, runtimeRequestId: nativeRootRequestId },
              ),
              runtimeRequestEvent({ now: before.updatedAt }, threadId, turn.runId, request),
              turnItemEvent({ now: before.updatedAt }, nativeItem),
            ],
            result: undefined,
          }),
        );

        const pending = (yield* snapshot(engine)).projection;
        const pendingRequest = pending.runtimeRequests.find(
          (candidate) => candidate.id === nativeRootRequestId,
        )!;
        expect(isCloudApprovalRequest(pending, pendingRequest)).toBe(false);
        yield* engine.dispatch(
          owner,
          {
            type: "runtime-request.respond",
            commandId: CommandId.make("answer-native-root"),
            threadId,
            requestId: nativeRootRequestId,
            decision: "accept",
          },
          personal,
        );

        const responses = (yield* runner.work).runtimeResponses;
        expect(responses).toMatchObject([
          {
            type: "runtime-request.respond",
            requestId: nativeRootRequestId,
            runId: turn.runId,
            attemptId: attempt.id,
            providerSessionId: report.started.providerSession.id,
            decision: "accept",
          },
        ]);
        expect(responses).toHaveLength(1);
        expect(requestItemId(nativeRootRequestId)).not.toBe(nativeItem.id);
      }),
    ),
  );

  it.effect("expires a native question before a new Runner continues the run", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { machine, turn } = yield* waiting(engine, runner);
        yield* runner.hello({
          ...hello(machine.generation, machine.token),
          runtimeResponses: false,
          takenRunIds: [turn.runId],
        });

        const drain = yield* runner.reconcile;
        expect(drain.drain?.generation).toBe(machine.generation);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 3,
          items: [{ kind: "machine.drained", id: drain.drain!.id, unsaved: [] }],
        });
        const upgraded = yield* runner.reconcile;
        expect(upgraded.ensure?.generation).toBe(machine.generation + 1);

        const recovered = (yield* snapshot(engine)).projection;
        expect(recovered.runtimeRequests.find((request) => request.id === requestId)?.status).toBe(
          "expired",
        );
        expect(threadShellFromProjection(recovered).pendingRuntimeRequest).toBeNull();
        expect(recovered.runs).toHaveLength(2);

        yield* runner.ensured(upgraded.ensure!.generation);
        yield* runner.hello({
          ...hello(upgraded.ensure!.generation, upgraded.ensure!.token),
          takenRunIds: [],
        });
        const resumed = yield* runner.work;
        expect(resumed.turn?.runId).toBe(recovered.runs[1]?.id);
        expect(resumed.runtimeResponses).toEqual([]);
      }),
    ),
  );

  it("uses a plain explanation for an unavailable action", () => {
    expect(unsupported()).toBe("This action isn't available in the cloud yet.");
  });
  it.effect("projects needs-you and earns one push, then clears it on the committed answer", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { before } = yield* waiting(engine, runner);
        const shell = threadShellFromProjection((yield* snapshot(engine)).projection);
        expect(shell.pendingRuntimeRequest).toMatchObject({ id: requestId, kind: "user_input" });
        expect(shell.status).toBe("waiting");
        const notification = {
          environmentId: EnvironmentId.make("cloud"),
          previous: threadShellFromProjection(before),
          next: shell,
          now: 0,
        };
        expect(pushFor(notification)?.phase).toBe("waiting_for_input");
        expect(pushFor({ ...notification, previous: shell })).toBeNull();
        yield* engine.dispatch(owner, answer(), personal);
        const resolved = threadShellFromProjection((yield* snapshot(engine)).projection);
        expect(resolved.pendingRuntimeRequest).toBeNull();
        expect(resolved.status).toBe("running");
      }),
    ),
  );

  it.effect(
    "replays the receipt and committed answer after object eviction without replacing it",
    () => {
      const database = freshDatabase();
      return Effect.gen(function* () {
        yield* withObject(database, (engine, runner) =>
          Effect.gen(function* () {
            yield* waiting(engine, runner);
            yield* engine.dispatch(owner, answer(), personal);
            const head = (yield* snapshot(engine)).head;
            yield* engine.dispatch(owner, { ...answer(), answers: { choice: "Red" } }, personal);
            expect((yield* snapshot(engine)).head).toBe(head);
            expect(
              yield* Effect.result(engine.dispatch(owner, answer("different-command"), personal)),
            ).toMatchObject({ _tag: "Failure" });
          }),
        );
        yield* withObject(database, (engine, runner) =>
          Effect.gen(function* () {
            expect((yield* snapshot(engine)).projection.runtimeRequests[0]).toMatchObject({
              status: "resolved",
              answers: { choice: "Blue" },
            });
            expect((yield* runner.work).runtimeResponses).toMatchObject([
              { type: "runtime-request.respond", requestId, answers: { choice: "Blue" } },
            ]);
          }),
        );
      });
    },
  );

  it.effect(
    "dismisses the native question with cancel and rejects late answers after interruption",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { machine, item, turn } = yield* waiting(engine, runner);
          yield* engine.dispatch(
            owner,
            {
              type: "thread.user-input.dismiss",
              commandId: CommandId.make("dismiss-1"),
              threadId,
              requestId,
            },
            personal,
          );
          expect((yield* runner.work).runtimeResponses).toMatchObject([
            { requestId, decision: "cancel" },
          ]);
          // Replayed provider state cannot reopen a committed answer.
          yield* runner.batch({ generation: machine.generation, sequence: 3, items: [item] });
          expect((yield* snapshot(engine)).projection.runtimeRequests[0]?.status).toBe("resolved");
          yield* engine.dispatch(
            owner,
            {
              type: "run.interrupt",
              commandId: CommandId.make("stop-1"),
              threadId,
              runId: turn.runId,
            },
            personal,
          );
          expect((yield* runner.work).runtimeResponses).toEqual([]);
          expect(yield* Effect.result(engine.dispatch(owner, answer(), personal))).toMatchObject({
            _tag: "Failure",
          });
          expect((yield* engine.summary(owner))?.shell.pendingRuntimeRequest).toBeNull();
        }),
      ),
  );

  it.effect("expires a pending question on stop and ignores late pending events", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { machine, item, turn } = yield* waiting(engine, runner);
        const pending = (yield* snapshot(engine)).projection;
        yield* engine.dispatch(
          owner,
          {
            type: "run.interrupt",
            commandId: CommandId.make("stop-1"),
            threadId,
            runId: turn.runId,
          },
          personal,
        );
        yield* runner.batch({
          generation: machine.generation,
          sequence: 3,
          items: [
            item,
            {
              kind: "provider",
              runId: turn.runId,
              event: {
                type: "node.updated",
                node: encodeNode(
                  pending.nodes.find((node) => node.runtimeRequestId === requestId)!,
                ),
              },
            },
            {
              kind: "provider",
              runId: turn.runId,
              event: {
                type: "turn_item.updated",
                turnItem: encodeItem(
                  pending.turnItems.find((item) => item.id === "question-item")!,
                ),
              },
            },
          ],
        });
        const stopped = (yield* snapshot(engine)).projection;
        expect(stopped.runtimeRequests[0]?.status).toBe("expired");
        expect(stopped.nodes.find((node) => node.runtimeRequestId === requestId)?.status).toBe(
          "cancelled",
        );
        expect(stopped.turnItems.find((item) => item.id === "question-item")?.status).toBe(
          "cancelled",
        );
        expect(derivePendingThreadRequests(stopped).userInputs).toEqual([]);
        expect((yield* engine.summary(owner))?.shell.pendingRuntimeRequest).toBeNull();
        expect(yield* Effect.result(engine.dispatch(owner, answer(), personal))).toMatchObject({
          _tag: "Failure",
        });
      }),
    ),
  );

  it.effect("retires questions left pending by older builds when a stopped thread loads", () => {
    const database = freshDatabase();
    return Effect.gen(function* () {
      yield* withObject(database, (engine, runner) =>
        Effect.gen(function* () {
          const { turn } = yield* waiting(engine, runner);
          const projection = (yield* snapshot(engine)).projection;
          const run = projection.runs.find((run) => run.id === turn.runId)!;
          // Older cloud builds stopped runs without expiring their callbacks.
          yield* engine.apply(() =>
            Effect.succeed({
              events: [
                runEvent({ now: projection.updatedAt }, "run.updated", {
                  ...run,
                  status: "interrupted",
                  completedAt: projection.updatedAt,
                }),
              ],
              result: undefined,
            }),
          );
        }),
      );
      const repairedHead = yield* withObject(database, (engine) =>
        Effect.gen(function* () {
          const repaired = yield* snapshot(engine);
          expect(repaired.projection.runtimeRequests[0]?.status).toBe("expired");
          expect(derivePendingThreadRequests(repaired.projection).userInputs).toEqual([]);
          expect(threadShellFromProjection(repaired.projection).pendingRuntimeRequest).toBeNull();
          return repaired.head;
        }),
      );
      yield* withObject(database, (engine) =>
        Effect.gen(function* () {
          expect((yield* snapshot(engine)).head).toBe(repairedHead);
        }),
      );
    });
  });

  it.effect.each(["accept", "decline"] as const)(
    "commits %s for an approval and resumes the waiting run",
    (decision) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { before } = yield* waiting(engine, runner, "command");
          const pending = (yield* snapshot(engine)).projection;
          const shell = threadShellFromProjection(pending);
          expect(shell.pendingRuntimeRequest?.kind).toBe("command");
          expect(
            pushFor({
              environmentId: EnvironmentId.make("cloud"),
              previous: threadShellFromProjection(before),
              next: shell,
              now: 0,
            })?.phase,
          ).toBe("waiting_for_approval");
          yield* engine.dispatch(owner, { ...answer(), answers: undefined, decision }, personal);
          const resolved = (yield* snapshot(engine)).projection;
          expect(resolved.runtimeRequests[0]).toMatchObject({ status: "resolved", decision });
          expect(derivePendingThreadRequests(resolved).approvals).toEqual([]);
          expect(threadShellFromProjection(resolved).status).toBe("running");
          expect((yield* runner.work).runtimeResponses).toMatchObject([{ requestId, decision }]);
        }),
      ),
  );

  it.effect("routes a completed message question through Threads into one new user turn", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { machine, report } = yield* waiting(engine, runner, "user_input", true);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 3,
          items: [report.terminal],
        });
        expect((yield* snapshot(engine)).projection.runtimeRequests[0]?.status).toBe("pending");
        const directory = makeMemoryCloud().threadDirectory;
        const service = yield* Threads.Threads.pipe(
          Effect.provide(
            ThreadsLive.layer.pipe(
              Layer.provide(
                Layer.succeed(ThreadDirectory.ThreadDirectory, {
                  forThread: (id) => ({ ...directory.forThread(id), dispatch: engine.dispatch }),
                }),
              ),
              Layer.provide(layerPersonalThreadContexts(owner.userId)),
              Layer.provide(Platform.layerCrypto),
              Layer.provide(layerAttachments(makeMemoryObjects())),
            ),
          ),
        );
        yield* service.dispatch(owner, answer());
        const projection = (yield* snapshot(engine)).projection;
        expect(projection.runs).toHaveLength(2);
        expect(
          projection.messages.find((message) => message.id === `async-answer:${requestId}`)?.text,
        ).toBe("Which colour?\nBlue");
        expect(threadShellFromProjection(projection).pendingRuntimeRequest).toBeNull();
        expect((yield* runner.work).runtimeResponses).toEqual([]);
        yield* service.dispatch(owner, answer());
        expect((yield* snapshot(engine)).projection.runs).toHaveLength(2);
      }),
    ),
  );

  it.effect("dismisses a message question without starting another turn", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* waiting(engine, runner, "user_input", true);
        yield* engine.dispatch(
          owner,
          {
            type: "thread.user-input.dismiss",
            commandId: CommandId.make("dismiss-message"),
            threadId,
            requestId,
          },
          personal,
        );
        const projection = (yield* snapshot(engine)).projection;
        expect(projection.runs).toHaveLength(1);
        expect(derivePendingThreadRequests(projection).userInputs).toEqual([]);
        expect(threadShellFromProjection(projection).pendingRuntimeRequest).toBeNull();
      }),
    ),
  );
});
