import { describe, expect, it } from "@effect/vitest";
import {
  RuntimeRequestId,
  ProviderSessionId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  NodeId,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import { ProviderAdapterRuntimeRequestResponseError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { fixture } from "./fixture.ts";

const pending = (f: Effect.Success<typeof fixture>): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make("request"),
  nodeId: f.turn.rootNodeId,
  providerTurnId: f.native().id,
  nativeRequestRef: { driver: f.runtime.driver, nativeId: "native-request", strength: "strong" },
  kind: "user_input",
  status: "pending",
  responseCapability: { type: "live", providerSessionId: f.runtime.providerSessionId },
  createdAt: f.native().startedAt!,
  resolvedAt: null,
});

const running = Effect.gen(function* () {
  const f = yield* fixture;
  const opened = yield* f.open();
  yield* opened.session.turn(f.turn);
  yield* opened.next;
  yield* opened.next;
  yield* f.named();
  yield* opened.next;
  const request = pending(f);
  yield* f.emit({
    type: "runtime_request.updated",
    driver: f.runtime.driver,
    runtimeRequest: request,
  });
  yield* opened.next;
  return { ...f, ...opened, request };
});

const answer = (f: Effect.Success<typeof running>) => ({
  type: "runtime-request.respond" as const,
  runId: f.turn.runId,
  attemptId: f.turn.attemptId,
  providerSessionId: f.runtime.providerSessionId,
  requestId: f.request.id,
  answers: { answer: ["exact", { nested: true }] },
});

const finish = (f: Effect.Success<typeof running>) =>
  Effect.gen(function* () {
    yield* f.terminal();
    yield* f.next;
    return yield* f.next;
  });

describe("AdapterHarness retained requests", () => {
  it.effect("still rejects pending live callbacks in export and checkpoint reopen", () =>
    Effect.gen(function* () {
      const f = yield* running;
      yield* f.session.control(answer(f));
      yield* f.next;
      yield* finish(f);
      const checkpoint = yield* f.session.export();
      const live = { ...f.request, id: RuntimeRequestId.make("unanswered-live") };
      f.setSnapshot({ ...checkpoint.snapshot, runtimeRequests: [live] });
      expect(Result.isFailure(yield* f.session.export().pipe(Effect.result))).toBe(true);
      expect(
        Result.isFailure(
          yield* f.service
            .open({
              ...f.input,
              checkpoint: {
                ...checkpoint,
                snapshot: { ...checkpoint.snapshot, runtimeRequests: [live] },
              },
            })
            .pipe(Effect.result),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "suppresses equivalent pending replays before resolution and publishes meaningful updates",
    () =>
      Effect.gen(function* () {
        const f = yield* running;
        const replay = {
          ...f.request,
          nativeRequestRef: { ...f.request.nativeRequestRef! },
          responseCapability: { ...f.request.responseCapability },
        };
        yield* f.emit({
          type: "runtime_request.updated",
          driver: f.runtime.driver,
          runtimeRequest: replay,
        });
        yield* f.named();
        while (true) {
          const item = yield* f.next;
          if (item.kind === "provider" && item.event.type === "provider_turn.updated") break;
        }
        const updates = () =>
          f.events.filter(
            (item) => item.kind === "provider" && item.event.type === "runtime_request.updated",
          );
        expect(updates()).toHaveLength(1);
        const changed = {
          ...f.request,
          responseCapability: { type: "not_resumable" as const, reason: "Callback closed" },
        };
        yield* f.emit({
          type: "runtime_request.updated",
          driver: f.runtime.driver,
          runtimeRequest: changed,
        });
        yield* f.emit({
          type: "runtime_request.updated",
          driver: f.runtime.driver,
          runtimeRequest: { ...changed },
        });
        yield* f.named();
        while (true) {
          const item = yield* f.next;
          if (item.kind === "provider" && item.event.type === "provider_turn.updated") break;
        }
        expect(updates()).toHaveLength(2);
        expect(updates().at(-1)).toMatchObject({
          event: {
            runtimeRequest: { status: "pending", responseCapability: changed.responseCapability },
          },
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps failed delivery pending until terminal cancellation, with no resolved event",
    () =>
      Effect.gen(function* () {
        const f = yield* running;
        f.setResponseEffect(
          Effect.fail(
            new ProviderAdapterRuntimeRequestResponseError({
              driver: f.runtime.driver,
              requestId: f.request.id,
            }),
          ),
        );
        expect(Result.isFailure(yield* f.session.control(answer(f)).pipe(Effect.result))).toBe(
          true,
        );
        yield* f.named();
        expect((yield* f.next).kind === "provider").toBe(true);
        expect(
          f.events.filter(
            (item) => item.kind === "provider" && item.event.type === "runtime_request.updated",
          ),
        ).toHaveLength(1);
        yield* f.terminal();
        yield* f.next;
        yield* f.next;
        yield* f.next;
        expect((yield* f.session.export()).snapshot.runtimeRequests[0]?.status).toBe("cancelled");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "retains a provider-resolved answer without duplicating it or reviving a stale snapshot",
    () =>
      Effect.gen(function* () {
        const f = yield* running;
        const resolved = {
          ...f.request,
          status: "resolved" as const,
          resolvedAt: f.request.createdAt,
          answers: { answer: "provider answer" },
        };
        yield* f.emit({
          type: "runtime_request.updated",
          driver: f.runtime.driver,
          runtimeRequest: resolved,
        });
        yield* f.next;
        expect(Result.isFailure(yield* f.session.control(answer(f)).pipe(Effect.result))).toBe(
          true,
        );
        yield* f.emit({
          type: "runtime_request.updated",
          driver: f.runtime.driver,
          runtimeRequest: resolved,
        });
        yield* f.emit({
          type: "runtime_request.updated",
          driver: f.runtime.driver,
          runtimeRequest: f.request,
        });
        yield* f.named();
        const barrier = yield* f.next;
        expect(barrier.kind === "provider" && barrier.event.type).toBe("provider_turn.updated");
        yield* finish(f);
        f.setSnapshot({
          providerThread: {
            ...f.turn.providerThread,
            nativeThreadRef: {
              driver: f.runtime.driver,
              nativeId: "native-thread",
              strength: "strong",
            },
          },
          providerTurns: [],
          messages: [],
          runtimeRequests: [f.request],
        });
        expect((yield* f.session.export()).snapshot.runtimeRequests).toEqual([resolved]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "drops foreign request events and rejects a snapshot with a changed request identity",
    () =>
      Effect.gen(function* () {
        const f = yield* running;
        yield* f.emit({
          type: "runtime_request.updated",
          driver: f.runtime.driver,
          runtimeRequest: {
            ...f.request,
            id: RuntimeRequestId.make("foreign-session"),
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make("foreign"),
            },
          },
        });
        yield* f.emit({
          type: "runtime_request.updated",
          driver: f.runtime.driver,
          runtimeRequest: {
            ...f.request,
            id: RuntimeRequestId.make("foreign-turn"),
            providerTurnId: ProviderTurnId.make("foreign"),
          },
        });
        yield* f.named();
        const barrier = yield* f.next;
        expect(barrier.kind === "provider" && barrier.event.type).toBe("provider_turn.updated");
        yield* f.session.control(answer(f));
        yield* f.next;
        yield* finish(f);
        const checkpoint = yield* f.session.export();
        expect(checkpoint.snapshot.runtimeRequests).toHaveLength(1);
        f.setSnapshot({
          ...checkpoint.snapshot,
          runtimeRequests: [
            {
              ...f.request,
              nativeRequestRef: {
                driver: f.runtime.driver,
                nativeId: "foreign-request",
                strength: "strong",
              },
            },
          ],
        });
        expect(Result.isFailure(yield* f.session.export().pipe(Effect.result))).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("retains answered requests across turns and ignores late pending replay", () =>
    Effect.gen(function* () {
      const f = yield* running;
      yield* f.session.control(answer(f));
      yield* f.next;
      yield* finish(f);
      yield* f.emit({
        type: "runtime_request.updated",
        driver: f.runtime.driver,
        runtimeRequest: { ...f.request, id: RuntimeRequestId.make("late") },
      });
      yield* f.named();
      const trailing = yield* f.next;
      expect(trailing.kind === "provider" && trailing.event.type).toBe("provider_turn.updated");
      const nextTurn = {
        ...f.turn,
        runId: RunId.make("next-run"),
        attemptId: RunAttemptId.make("next-attempt"),
        rootNodeId: NodeId.make("next-root"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
      };
      yield* f.session.turn(nextTurn);
      yield* f.next;
      yield* f.named(nextTurn);
      yield* f.next;
      const second = {
        ...f.request,
        id: RuntimeRequestId.make("second"),
        providerTurnId: f.native(nextTurn).id,
        nodeId: nextTurn.rootNodeId,
        nativeRequestRef: { ...f.request.nativeRequestRef!, nativeId: "second-native" },
      };
      yield* f.emit({
        type: "runtime_request.updated",
        driver: f.runtime.driver,
        runtimeRequest: second,
      });
      yield* f.next;
      yield* f.session.control({
        ...answer(f),
        runId: nextTurn.runId,
        attemptId: nextTurn.attemptId,
        requestId: second.id,
      });
      yield* f.next;
      yield* f.terminal(nextTurn);
      yield* f.next;
      yield* f.next;
      const checkpoint = yield* f.session.export();
      expect(checkpoint.snapshot.runtimeRequests).toEqual([
        {
          ...f.request,
          status: "resolved",
          resolvedAt: expect.anything(),
          answers: answer(f).answers,
        },
        {
          ...second,
          status: "resolved",
          resolvedAt: expect.anything(),
          answers: answer(f).answers,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "publishes the exact answer and exports it through native-only snapshots and reopen",
    () =>
      Effect.gen(function* () {
        const f = yield* running;
        const response = answer(f);
        yield* f.session.control(response);
        yield* f.named();
        const resolved = yield* f.next;
        expect(resolved.kind === "provider" && resolved.event).toMatchObject({
          type: "runtime_request.updated",
          runtimeRequest: {
            ...f.request,
            createdAt: expect.any(String),
            status: "resolved",
            resolvedAt: expect.any(String),
            answers: response.answers,
          },
        });
        yield* f.next;
        yield* finish(f);
        const checkpoint = yield* f.session.export();
        expect(checkpoint.snapshot.runtimeRequests).toEqual([
          {
            ...f.request,
            status: "resolved",
            resolvedAt: expect.anything(),
            answers: response.answers,
          },
        ]);
        const reopened = yield* f.open({ ...f.input, checkpoint });
        expect((yield* reopened.session.export()).snapshot.runtimeRequests).toEqual(
          checkpoint.snapshot.runtimeRequests,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("cancels only unanswered live requests at terminal and rejects late answers", () =>
    Effect.gen(function* () {
      const f = yield* running;
      yield* f.terminal();
      yield* f.next;
      const cancelled = yield* f.next;
      expect(cancelled.kind === "provider" && cancelled.event).toMatchObject({
        type: "runtime_request.updated",
        runtimeRequest: { id: f.request.id, status: "cancelled" },
      });
      yield* f.next;
      expect(Result.isFailure(yield* f.session.control(answer(f)).pipe(Effect.result))).toBe(true);
      expect((yield* f.session.export()).snapshot.runtimeRequests).toEqual([
        { ...f.request, status: "cancelled", resolvedAt: expect.anything() },
      ]);
    }).pipe(Effect.scoped),
  );
});
