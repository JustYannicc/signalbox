import type { SecretRequest } from "@signalbox/runner-protocol/SecretRequestProtocol";
import {
  SecretRequestError,
  TurnItemId,
  type OrchestratorMcpRequestSecretResult,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type SecretRef,
  type SecretRequestAnswerInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { activeRun } from "../runLifecycle.ts";
import { type Actor, type EngineDecision, ThreadEngine } from "../ThreadEngine.ts";
import { type DecisionContext, runEvent, turnItemEvent } from "../threadEvents.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { positionTurnItem } from "../runner/runnerEvents.ts";
import * as ThreadSecretStore from "./ThreadSecretStore.ts";

type Projection = OrchestrationV2ThreadProjection;
type SecretItem = Extract<OrchestrationV2TurnItem, { readonly type: "secret_request" }>;
type Binding = { readonly runId: string; readonly attemptId: string; readonly generation: number };

/** A blocked HTTP request must publish its new card before the person can answer it. */
export const SecretRequestChanged = Context.Reference<Effect.Effect<void>>(
  "@signalbox/cloud/thread/secrets/SecretRequestChanged",
  { defaultValue: (): Effect.Effect<void> => Effect.void },
);

export class ThreadSecretRequests extends Context.Service<
  ThreadSecretRequests,
  {
    readonly request: (
      generation: number,
      request: SecretRequest,
    ) => Effect.Effect<OrchestratorMcpRequestSecretResult, SecretRequestError>;
    readonly answer: (
      actor: Actor,
      input: SecretRequestAnswerInput,
    ) => Effect.Effect<void, SecretRequestError>;
    /** Only an approved server-side consumer receives the value, never a runner or public RPC. */
    readonly consume: (
      input: Binding & { readonly ref: SecretRef; readonly projectId: string },
    ) => Effect.Effect<string, SecretRequestError>;
  }
>()("@signalbox/cloud/thread/secrets/ThreadSecretRequests") {}

const itemEvents = (projection: Projection, item: SecretItem, ctx: DecisionContext) => {
  const run = projection.runs.find((candidate) => candidate.id === item.runId);
  const pending =
    item.secretStatus === "pending" ||
    projection.runtimeRequests.some(
      (request) =>
        request.status === "pending" &&
        projection.nodes.some((node) => node.id === request.nodeId && node.runId === item.runId),
    ) ||
    projection.turnItems.some(
      (other) =>
        other.id !== item.id &&
        other.runId === item.runId &&
        other.type === "secret_request" &&
        other.secretStatus === "pending",
    );
  return [
    turnItemEvent(ctx, positionTurnItem(projection, item)),
    ...(run === undefined ||
    (run.status !== "preparing" &&
      run.status !== "starting" &&
      run.status !== "running" &&
      run.status !== "waiting")
      ? []
      : [runEvent(ctx, "run.updated", { ...run, status: pending ? "waiting" : "running" })]),
  ];
};

const make = Effect.gen(function* () {
  const engine = yield* ThreadEngine;
  const store = yield* ThreadStore;
  const secrets = yield* ThreadSecretStore.ThreadSecretStore;
  const crypto = yield* Crypto.Crypto;
  const changed = yield* SecretRequestChanged;

  // Custody writes precede the card commit under the same orchestration lock.
  // A failed commit leaves the first value available for retry, never replaceable.
  const locked = <A>(
    decide: (
      projection: Projection | null,
      ctx: DecisionContext,
    ) => Effect.Effect<EngineDecision<A>, SecretRequestError>,
  ) =>
    engine
      .apply<Result.Result<A, SecretRequestError>>((projection, ctx) =>
        decide(projection, ctx).pipe(
          Effect.match({
            onFailure: (error) => ({ events: [], result: Result.fail(error) }),
            onSuccess: (decision) => ({ ...decision, result: Result.succeed(decision.result) }),
          }),
        ),
      )
      .pipe(
        Effect.flatMap((result) =>
          Result.isFailure(result) ? Effect.fail(result.failure) : Effect.succeed(result.success),
        ),
      );

  const current = (projection: Projection | null, binding: Binding) =>
    Effect.gen(function* () {
      const lease = yield* store.machine.pipe(
        Effect.mapError(() => new SecretRequestError({ reason: "load_failed" })),
      );
      const run = projection === null ? undefined : activeRun(projection);
      if (
        projection === null ||
        run?.id !== binding.runId ||
        run.activeAttemptId !== binding.attemptId ||
        lease.status === "none" ||
        lease.generation !== binding.generation
      ) {
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
      return { projection, run };
    });

  const completion = (projection: Projection | null, requestId: TurnItemId, binding: Binding) =>
    Effect.gen(function* (): Effect.fn.Return<
      OrchestratorMcpRequestSecretResult | null,
      SecretRequestError
    > {
      const item = projection?.turnItems.find((candidate) => candidate.id === requestId);
      if (item?.type !== "secret_request")
        return yield* new SecretRequestError({ reason: "not_found" });
      if (item.secretStatus === "saved") {
        const valid = yield* current(projection, binding).pipe(Effect.result);
        if (Result.isFailure(valid)) {
          if (valid.failure.reason === "agent_stopped") return { status: "cancelled" };
          return yield* valid.failure;
        }
        const row = yield* secrets.read(requestId);
        if (row === null || row.consumed !== 0)
          return yield* new SecretRequestError({ reason: "ref_unavailable" });
        return { status: "saved", secretRef: row.ref };
      }
      if (item.secretStatus !== "pending") return { status: item.secretStatus };
      return yield* current(projection, binding).pipe(
        Effect.as(null),
        Effect.catchTags({
          SecretRequestError: () => Effect.succeed({ status: "cancelled" } as const),
        }),
      );
    });

  const close = (requestId: TurnItemId, binding: Binding) =>
    locked((projection, ctx) =>
      Effect.sync(() => {
        const item = projection?.turnItems.find((candidate) => candidate.id === requestId);
        if (
          projection === null ||
          item?.type !== "secret_request" ||
          item.runId !== binding.runId ||
          item.secretStatus !== "pending"
        ) {
          return { events: [], result: undefined };
        }
        return {
          events: itemEvents(
            projection,
            {
              ...item,
              secretStatus: "cancelled",
              status: "cancelled",
              completedAt: ctx.now,
              updatedAt: ctx.now,
            },
            ctx,
          ),
          result: undefined,
        };
      }),
    ).pipe(Effect.tap(() => changed));

  const request: ThreadSecretRequests["Service"]["request"] = (generation, request) =>
    Effect.gen(function* () {
      const binding = { generation, runId: request.runId, attemptId: request.attemptId };
      const key =
        request.input.clientRequestId ??
        (yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" }))));
      const requestId = TurnItemId.make(`turn-item:secret-request:${request.runId}:${key}`);
      yield* locked((projection, ctx) =>
        Effect.gen(function* () {
          const { projection: live, run } = yield* current(projection, binding);
          if (run.rootNodeId === null)
            return yield* new SecretRequestError({ reason: "agent_stopped" });
          const existing = live.turnItems.find((item) => item.id === requestId);
          if (existing !== undefined) {
            const row = yield* secrets.read(requestId);
            if (row?.generation !== generation || row.attempt_id !== request.attemptId)
              return yield* new SecretRequestError({ reason: "agent_stopped" });
            return { events: [], result: undefined };
          }
          yield* secrets.open({ requestId, ...binding });
          const item: SecretItem = {
            id: requestId,
            threadId: live.thread.id,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: run.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "waiting",
            title: request.input.label,
            startedAt: ctx.now,
            completedAt: null,
            updatedAt: ctx.now,
            type: "secret_request",
            label: request.input.label,
            reason: request.input.reason,
            secretStatus: "pending",
            ...(request.input.placeholder === undefined
              ? {}
              : { placeholder: request.input.placeholder }),
          };
          return { events: itemEvents(live, item, ctx), result: undefined };
        }),
      );
      yield* changed;
      const owner = yield* store.owner.pipe(
        Effect.mapError(() => new SecretRequestError({ reason: "load_failed" })),
      );
      if (owner === null) return yield* new SecretRequestError({ reason: "not_found" });
      const projection = yield* engine.projection;
      if (projection === null) return yield* new SecretRequestError({ reason: "not_found" });
      const stream = yield* engine
        .subscribe(
          { userId: owner.userId, contextIds: [owner.contextId] },
          { threadId: projection.thread.id },
        )
        .pipe(Effect.mapError(() => new SecretRequestError({ reason: "not_found" })));
      const answer = yield* stream.pipe(
        Stream.mapEffect(() =>
          Effect.flatMap(engine.projection, (next) => completion(next, requestId, binding)),
        ),
        Stream.filter((result): result is OrchestratorMcpRequestSecretResult => result !== null),
        Stream.runHead,
        Effect.timeoutOption(request.input.timeoutMs ?? 600_000),
        Effect.onExit(() => close(requestId, binding).pipe(Effect.ignore)),
      );
      if (Option.isSome(answer) && Option.isSome(answer.value)) return answer.value.value;
      // A save that won the timeout race still owns the request.
      const final = yield* completion(yield* engine.projection, requestId, binding);
      return final?.status === "saved" || final?.status === "declined"
        ? final
        : { status: "timed_out" as const };
    }).pipe(Effect.withSpan("ThreadSecretRequests.request"));

  const answer: ThreadSecretRequests["Service"]["answer"] = (actor, input) =>
    Effect.gen(function* () {
      if (!(yield* engine.canSee(actor)))
        return yield* new SecretRequestError({ reason: "not_found" });
      yield* locked((projection, ctx) =>
        Effect.gen(function* () {
          if (projection?.thread.id !== input.threadId)
            return yield* new SecretRequestError({ reason: "not_found" });
          const item = projection.turnItems.find((candidate) => candidate.id === input.turnItemId);
          if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null)
            return yield* new SecretRequestError({ reason: "not_found" });
          if (item.secretStatus !== "pending")
            return yield* new SecretRequestError({ reason: "already_answered" });
          const row = yield* secrets.read(item.id);
          if (row === null) return yield* new SecretRequestError({ reason: "not_found" });
          yield* current(projection, {
            runId: row.run_id,
            attemptId: row.attempt_id,
            generation: row.generation,
          });
          if (input.answer.type === "save")
            yield* secrets.save(item.id, input.answer.secret, DateTime.toEpochMillis(ctx.now));
          return {
            events: itemEvents(
              projection,
              {
                ...item,
                secretStatus:
                  input.answer.type === "save" || row.value !== null ? "saved" : "declined",
                status: "completed",
                completedAt: ctx.now,
                updatedAt: ctx.now,
              },
              ctx,
            ),
            result: undefined,
          };
        }),
      );
      yield* changed;
    }).pipe(Effect.withSpan("ThreadSecretRequests.answer"));

  const consume: ThreadSecretRequests["Service"]["consume"] = (input) =>
    locked((projection) =>
      Effect.gen(function* () {
        const { projection: live } = yield* current(projection, input);
        if (live.thread.projectId !== input.projectId)
          return yield* new SecretRequestError({ reason: "ref_unavailable" });
        const value = yield* secrets.consume(
          input.ref,
          input.runId,
          input.attemptId,
          input.generation,
          yield* Clock.currentTimeMillis,
        );
        return { events: [], result: value };
      }),
    );
  return ThreadSecretRequests.of({ request, answer, consume });
});

export const layer = Layer.effect(ThreadSecretRequests, make);
