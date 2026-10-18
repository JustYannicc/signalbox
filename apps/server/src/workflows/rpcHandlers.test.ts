import { expect, it } from "@effect/vitest";
import { AUTOMATION_WS_METHODS, AutomationError, AutomationRpcs } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";

import { AUTOMATIONS_CLOUD_ONLY_MESSAGE } from "../signalbox/automationAvailability.ts";
import { automationRpcHandlers } from "./rpcHandlers.ts";

const streamingMethods = new Set<string>([
  AUTOMATION_WS_METHODS.automationsSubscribe,
  AUTOMATION_WS_METHODS.automationsSubscribeNotices,
  AUTOMATION_WS_METHODS.automationsSubscribeOne,
  AUTOMATION_WS_METHODS.automationsSubscribeRun,
]);
const group = RpcGroup.make(...AutomationRpcs);
const handlers = automationRpcHandlers();
const layer = group.toLayer(handlers);

it.effect("returns typed cloud-only errors through RPC subscriptions and mutations", () =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(group);
    const subscription = yield* client[AUTOMATION_WS_METHODS.automationsSubscribe]({}).pipe(
      Stream.runDrain,
      Effect.result,
    );
    const mutation = yield* client[AUTOMATION_WS_METHODS.automationsDelete]({
      automationId: "automation_test",
    }).pipe(Effect.result);

    expect(Result.isFailure(subscription)).toBe(true);
    expect(Result.isFailure(mutation)).toBe(true);
    if (Result.isFailure(subscription)) {
      expect(subscription.failure).toMatchObject({
        _tag: "AutomationError",
        message: AUTOMATIONS_CLOUD_ONLY_MESSAGE,
      });
    }
    if (Result.isFailure(mutation)) {
      expect(mutation.failure).toMatchObject({
        _tag: "AutomationError",
        message: AUTOMATIONS_CLOUD_ONLY_MESSAGE,
      });
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("maps every automation RPC instead of leaving a handler empty", () =>
  Effect.gen(function* () {
    const allHandlers = handlers as unknown as Readonly<Record<string, () => unknown>>;
    expect(Object.keys(allHandlers)).toHaveLength(Object.values(AUTOMATION_WS_METHODS).length);
    for (const [method, handler] of Object.entries(allHandlers)) {
      const result = streamingMethods.has(method)
        ? yield* Effect.result(
            Stream.runDrain(handler() as Stream.Stream<unknown, AutomationError>),
          )
        : yield* Effect.result(handler() as Effect.Effect<unknown, AutomationError>);
      expect(Result.isFailure(result), method).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure, method).toMatchObject({
          _tag: "AutomationError",
          message: AUTOMATIONS_CLOUD_ONLY_MESSAGE,
        });
      }
    }
  }),
);
