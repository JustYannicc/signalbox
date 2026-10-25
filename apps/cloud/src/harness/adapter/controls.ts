import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { HarnessError, type HarnessControl } from "../Harness.ts";
import type { ActiveTurn } from "./state.ts";

export const applyInterrupt = (runtime: ProviderAdapterV2SessionRuntime, active: ActiveTurn) =>
  Effect.gen(function* () {
    if (
      !active.interruptRequested ||
      active.interruptApplied ||
      active.nativeTurn?.status !== "running" ||
      active.nativeTurn.nativeTurnRef?.nativeId == null
    )
      return;
    yield* runtime
      .interruptTurn({
        providerThread: active.providerThread,
        providerTurnId: active.nativeTurn.id,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new HarnessError({
              operation: "control",
              message: "Provider interrupt failed.",
              cause,
            }),
        ),
      );
    active.interruptApplied = true;
  });

export const controlTurn = (
  runtime: ProviderAdapterV2SessionRuntime,
  active: ActiveTurn,
  input: HarnessControl,
) =>
  Effect.gen(function* () {
    if (input.runId !== active.input.runId) {
      return yield* Effect.fail(
        new HarnessError({
          operation: "control",
          message: "Control belongs to another run.",
        }),
      );
    }
    if (input.type === "interrupt") {
      if (input.preparationGeneration !== active.input.preparationGeneration) {
        return yield* Effect.fail(
          new HarnessError({
            operation: "control",
            message: "Interrupt belongs to another preparation.",
          }),
        );
      }
      active.interruptRequested = true;
      return yield* applyInterrupt(runtime, active);
    }
    const nativeTurn = active.nativeTurn;
    if (
      nativeTurn === undefined ||
      nativeTurn.status !== "running" ||
      nativeTurn.nativeTurnRef?.nativeId == null
    ) {
      return yield* Effect.fail(
        new HarnessError({
          operation: "control",
          message: "No native turn is running.",
        }),
      );
    }
    if (input.type === "steer") {
      if (active.steered.has(input.message.messageId)) return;
      if (active.steered.size >= 128) {
        return yield* Effect.fail(
          new HarnessError({
            operation: "control",
            message: "Turn steering limit reached.",
          }),
        );
      }
      yield* runtime
        .steerTurn({
          threadId: active.input.threadId,
          runId: active.input.runId,
          providerThread: active.providerThread,
          providerTurnId: nativeTurn.id,
          message: input.message,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new HarnessError({
                operation: "control",
                message: "Provider steering failed.",
                cause,
              }),
          ),
        );
      active.steered.add(input.message.messageId);
      return;
    }
    const request = active.requests.get(input.requestId);
    if (
      input.attemptId !== active.input.attemptId ||
      input.providerSessionId !== runtime.providerSessionId ||
      request?.providerTurnId !== nativeTurn.id ||
      request.status !== "pending" ||
      request.responseCapability.type !== "live" ||
      request.responseCapability.providerSessionId !== runtime.providerSessionId
    ) {
      return yield* Effect.fail(
        new HarnessError({
          operation: "control",
          message: "Runtime response is stale or belongs to another session.",
        }),
      );
    }
    if (active.answered.size >= 128) {
      return yield* Effect.fail(
        new HarnessError({
          operation: "control",
          message: "Runtime response limit reached.",
        }),
      );
    }
    yield* runtime
      .respondToRuntimeRequest({
        requestId: input.requestId,
        ...(input.decision === undefined ? {} : { decision: input.decision }),
        ...(input.answers === undefined ? {} : { answers: input.answers }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new HarnessError({
              operation: "control",
              message: "Provider response failed.",
              cause,
            }),
        ),
      );
    active.requests.delete(input.requestId);
    active.answered.add(input.requestId);
    return {
      ...request,
      status: "resolved" as const,
      resolvedAt: yield* DateTime.now,
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      ...(input.answers === undefined ? {} : { answers: input.answers }),
    };
  });
