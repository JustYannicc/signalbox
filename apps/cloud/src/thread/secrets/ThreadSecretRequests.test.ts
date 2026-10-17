import { RUNNER_PROTOCOL_VERSION } from "@signalbox/runner-protocol/RunnerProtocol";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpRequestSecretResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { layerThreadObject } from "../../testing.ts";
import { ThreadEngine } from "../ThreadEngine.ts";
import { ThreadRunner } from "../runner/ThreadRunner.ts";
import { turnReport } from "../runner/runnerTestKit.ts";
import * as ThreadSecretRequests from "./ThreadSecretRequests.ts";
import { secretRequestJson } from "@signalbox/runner-protocol/SecretRequestProtocol";
import { serveSecretRequest } from "./secretRequestRoutes.ts";

const threadId = ThreadId.make("secret-thread");
const projectId = ProjectId.make("scratch");
const owner = { userId: "owner", contextIds: [PERSONAL_CONTEXT_ID] };
const creation = {
  place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/owner" },
  pools: { top: PERSONAL_POOL_ID, projects: {} },
};

const withThread = <A, E>(
  use: (input: {
    readonly engine: ThreadEngine["Service"];
    readonly runner: ThreadRunner["Service"];
    readonly secrets: ThreadSecretRequests.ThreadSecretRequests["Service"];
    readonly generation: number;
    readonly request: {
      readonly runId: RunId;
      readonly attemptId: RunAttemptId;
      readonly input: {
        readonly label: string;
        readonly reason: string;
        readonly clientRequestId: string;
      };
    };
    readonly requestId: TurnItemId;
    readonly notified: Effect.Effect<void>;
    readonly notificationCount: () => number;
    readonly waitForCard: Effect.Effect<OrchestrationV2ThreadProjection>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const notification = yield* Deferred.make<void>();
      let notificationCount = 0;
      const changed = Effect.sync(() => {
        notificationCount += 1;
      }).pipe(Effect.andThen(Deferred.succeed(notification, undefined)), Effect.asVoid);
      const context = yield* Layer.build(
        layerThreadObject(":memory:").pipe(
          Layer.provide(Layer.succeed(ThreadSecretRequests.SecretRequestChanged, changed)),
        ),
      );
      const engine = Context.get(context, ThreadEngine);
      const runner = Context.get(context, ThreadRunner);
      const secrets = Context.get(context, ThreadSecretRequests.ThreadSecretRequests);
      yield* engine.launch(
        owner,
        {
          commandId: CommandId.make("launch"),
          threadId,
          projectId,
          title: "Secret request",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-5-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make("message"),
            text: "Configure my webhook.",
            attachments: [],
          },
        },
        creation,
      );
      const plan = yield* runner.reconcile;
      if (plan.ensure === null) throw new Error("Expected machine request");
      const generation = plan.ensure.generation;
      yield* runner.hello({
        type: "hello",
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        imageVersion: "test",
        machineId: "machine",
        threadId,
        generation,
        token: plan.ensure.token,
        lastAckedSequence: 0,
      });
      const projection = yield* engine.projection;
      const run = projection?.runs[0];
      if (run === undefined || run.activeAttemptId === null)
        throw new Error("Expected run and attempt");
      const request = {
        runId: run.id,
        attemptId: run.activeAttemptId,
        input: {
          label: "Webhook secret",
          reason: "Checks the signature.",
          clientRequestId: "request-1",
        },
      };
      const requestId = TurnItemId.make(`turn-item:secret-request:${run.id}:request-1`);
      const waitForCard = Effect.gen(function* () {
        const stream = yield* engine.subscribe(owner, { threadId }).pipe(Effect.orDie);
        const found = yield* stream.pipe(
          Stream.mapEffect(() => engine.projection),
          Stream.filter(
            (next): next is OrchestrationV2ThreadProjection =>
              next !== null && next.turnItems.some((item) => item.id === requestId),
          ),
          Stream.runHead,
        );
        if (Option.isNone(found)) throw new Error("Expected pending secret card");
        return found.value;
      });
      return yield* use({
        engine,
        runner,
        secrets,
        generation,
        request,
        requestId,
        waitForCard,
        notified: Deferred.await(notification),
        notificationCount: () => notificationCount,
      }).pipe(Effect.provide(context));
    }),
  );

describe("cloud secret requests", () => {
  it.effect(
    "privately saves the first answer, resumes its request, and consumes once in its scope",
    () =>
      withThread(
        ({
          engine,
          secrets,
          generation,
          request,
          requestId,
          waitForCard,
          notified,
          notificationCount,
        }) =>
          Effect.gen(function* () {
            const waiting = yield* secrets.request(generation, request).pipe(Effect.forkChild);
            const pending = yield* waitForCard;
            yield* notified;
            expect(notificationCount()).toBeGreaterThanOrEqual(1);
            expect(pending.turnItems.find((item) => item.id === requestId)).toMatchObject({
              type: "secret_request",
              secretStatus: "pending",
            });
            const value = "generated-test-value-for-private-custody";
            yield* secrets.answer(owner, {
              threadId,
              turnItemId: requestId,
              answer: { type: "save", secret: value },
            });
            expect(notificationCount()).toBeGreaterThanOrEqual(2);
            const result = yield* Fiber.join(waiting);
            expect(result.status).toBe("saved");
            if (result.status !== "saved") throw new Error("Expected saved ref");
            expect(JSON.stringify(yield* engine.snapshot(owner))).not.toContain(value);
            expect(JSON.stringify(result)).not.toContain(value);
            const retry = yield* secrets.request(generation, request);
            expect(retry).toEqual(result);
            const duplicate = yield* secrets
              .answer(owner, {
                threadId,
                turnItemId: requestId,
                answer: { type: "save", secret: "replacement" },
              })
              .pipe(Effect.result);
            expect(duplicate).toMatchObject({
              _tag: "Failure",
              failure: { reason: "already_answered" },
            });
            const scope = { ...request, generation, projectId, ref: result.secretRef };
            const wrongProject = yield* secrets
              .consume({ ...scope, projectId: "other" })
              .pipe(Effect.result);
            expect(wrongProject).toMatchObject({
              _tag: "Failure",
              failure: { reason: "ref_unavailable" },
            });
            expect(yield* secrets.consume(scope)).toBe(value);
            expect(yield* secrets.consume(scope).pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { reason: "ref_unavailable" },
            });
          }),
      ),
  );

  it.effect("declines without creating a value and refuses a second answer", () =>
    withThread(({ secrets, generation, request, requestId, waitForCard }) =>
      Effect.gen(function* () {
        const waiting = yield* secrets.request(generation, request).pipe(Effect.forkChild);
        yield* waitForCard;
        yield* secrets.answer(owner, {
          threadId,
          turnItemId: requestId,
          answer: { type: "decline" },
        });
        expect(yield* Fiber.join(waiting)).toEqual({ status: "declined" });
        expect(
          yield* secrets
            .answer(owner, { threadId, turnItemId: requestId, answer: { type: "decline" } })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "already_answered" } });
      }),
    ),
  );

  it.effect("rejects other people, missing cards, stale attempts and replaced machines", () =>
    withThread(({ secrets, generation, request, requestId, waitForCard }) =>
      Effect.gen(function* () {
        expect(
          yield* secrets
            .answer(owner, { threadId, turnItemId: requestId, answer: { type: "decline" } })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "not_found" } });
        expect(yield* secrets.request(generation + 1, request).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "agent_stopped" },
        });
        expect(
          yield* secrets
            .request(generation, { ...request, attemptId: RunAttemptId.make("old-attempt") })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "agent_stopped" } });
        const waiting = yield* secrets.request(generation, request).pipe(Effect.forkChild);
        yield* waitForCard;
        expect(
          yield* secrets
            .answer(
              { userId: "other", contextIds: [PERSONAL_CONTEXT_ID] },
              { threadId, turnItemId: requestId, answer: { type: "save", secret: "not-stored" } },
            )
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "not_found" } });
        yield* Fiber.interrupt(waiting);
      }),
    ),
  );

  it.effect("stopping the turn cancels its wait and refuses late answers", () =>
    withThread(({ engine, secrets, generation, request, requestId, waitForCard }) =>
      Effect.gen(function* () {
        const waiting = yield* secrets.request(generation, request).pipe(Effect.forkChild);
        yield* waitForCard;
        yield* engine.dispatch(
          owner,
          {
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: request.runId,
          },
          { pools: null, place: null },
        );
        expect(yield* Fiber.join(waiting)).toEqual({ status: "cancelled" });
        expect(
          yield* secrets
            .answer(owner, {
              threadId,
              turnItemId: requestId,
              answer: { type: "save", secret: "late" },
            })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "already_answered" } });
      }),
    ),
  );

  it.effect("the private HTTP response returns only status and opaque ref", () =>
    withThread(({ secrets, generation, request, requestId, waitForCard }) =>
      Effect.gen(function* () {
        const waiting = yield* serveSecretRequest(
          generation,
          secretRequestJson.request.encode(request),
        ).pipe(
          Effect.provideService(ThreadSecretRequests.ThreadSecretRequests, secrets),
          Effect.forkChild,
        );
        yield* waitForCard;
        yield* secrets.answer(owner, {
          threadId,
          turnItemId: requestId,
          answer: { type: "decline" },
        });
        const response = yield* Fiber.join(waiting);
        expect(response.status).toBe(200);
        expect(secretRequestJson.result.decode(response.body)).toEqual({
          status: "declined",
        } satisfies OrchestratorMcpRequestSecretResult);
      }),
    ),
  );

  it.effect("expires and erases a saved value before it can be consumed", () =>
    withThread(({ secrets, generation, request, requestId, waitForCard }) =>
      Effect.gen(function* () {
        const waiting = yield* secrets.request(generation, request).pipe(Effect.forkChild);
        yield* waitForCard;
        yield* secrets.answer(owner, {
          threadId,
          turnItemId: requestId,
          answer: { type: "save", secret: "fake-expiring-value" },
        });
        const result = yield* Fiber.join(waiting);
        if (result.status !== "saved") throw new Error("Expected saved ref");
        yield* TestClock.adjust(86_400_001);
        const input = { ...request, generation, projectId, ref: result.secretRef };
        expect(yield* secrets.consume(input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "ref_expired" },
        });
        expect(yield* secrets.consume(input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "ref_unavailable" },
        });
      }),
    ),
  );

  it.effect("closes an unanswered card at its requested deadline", () =>
    withThread(({ engine, secrets, generation, request, requestId, waitForCard }) =>
      Effect.gen(function* () {
        const waiting = yield* secrets
          .request(generation, { ...request, input: { ...request.input, timeoutMs: 1000 } })
          .pipe(Effect.forkChild);
        yield* waitForCard;
        yield* TestClock.adjust(1000);
        expect(yield* Fiber.join(waiting)).toEqual({ status: "timed_out" });
        const projection = yield* engine.projection;
        expect(projection?.turnItems.find((item) => item.id === requestId)).toMatchObject({
          secretStatus: "cancelled",
          status: "cancelled",
        });
      }),
    ),
  );

  it.effect(
    "a delayed started frame records the session while its private card keeps the run waiting",
    () =>
      withThread(({ engine, runner, secrets, generation, request, requestId, waitForCard }) =>
        Effect.gen(function* () {
          const turn = (yield* runner.work).turn;
          if (turn === null) throw new Error("Expected active runner turn");
          const waiting = yield* secrets.request(generation, request).pipe(Effect.forkChild);
          const pending = yield* waitForCard;
          expect(pending.runs.find((run) => run.id === request.runId)?.status).toBe("waiting");
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({ generation, sequence: 1, items: [report.started] });
          const afterStarted = yield* engine.projection;
          expect(afterStarted?.runs.find((run) => run.id === request.runId)).toMatchObject({
            status: "waiting",
          });
          expect(afterStarted?.providerSessions).toHaveLength(1);
          expect(afterStarted?.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(
            "claude-session-1",
          );
          expect(
            afterStarted?.attempts.find((attempt) => attempt.id === request.attemptId)?.status,
          ).toBe("running");
          yield* secrets.answer(owner, {
            threadId,
            turnItemId: requestId,
            answer: { type: "decline" },
          });
          expect(yield* Fiber.join(waiting)).toEqual({ status: "declined" });
          expect(
            (yield* engine.projection)?.runs.find((run) => run.id === request.runId)?.status,
          ).toBe("running");
        }),
      ),
  );
});
