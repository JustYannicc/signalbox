import "./threadCommandTestSession.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { ENVIRONMENT_ID, makeHarness, SNAPSHOT, THREAD_ID } from "./threadCommandTestHarness.ts";

const target = { environmentId: ENVIRONMENT_ID, input: { threadId: THREAD_ID } };

describe("optimistic pin command failures", () => {
  it.effect.each([
    [
      "RPC disconnect",
      new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1006 }) }),
    ],
    [
      "connection transport error",
      new ConnectionTransientError({ reason: "transport", detail: "Disconnected" }),
    ],
    ["timeout", new Cause.TimeoutError()],
  ] as const)("keeps a possibly committed command after a %s", ([_kind, error]) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.pin.run(h.registry, target);
      const request = yield* Queue.take(h.requests);
      yield* Deferred.fail(request.reply, error);

      expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeDefined();
      expect(
        h.registry.get(h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID))[0]?.status,
      ).toBe("unknown");
    }),
  );

  it.effect.each([
    "OrchestrationDispatchCommandError",
    "EnvironmentAuthorizationError",
    "EnvironmentRpcUnavailableError",
    "EnvironmentNotRegisteredError",
  ])("rolls back a definitive %s refusal", (_tag) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.pin.run(h.registry, target);
      const request = yield* Queue.take(h.requests);
      yield* Deferred.fail(request.reply, Object.assign(new Error("Refused"), { _tag }));

      expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
      expect(
        h.registry.get(h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID))[0]?.status,
      ).toBe("rejected");
    }),
  );

  it.effect("keeps a defect unconfirmed", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.pin.run(h.registry, target);
      const request = yield* Queue.take(h.requests);
      yield* Deferred.failCause(request.reply, Cause.die(new Error("Lost reply")));

      expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.pinnedAt).toBeDefined();
      expect(
        h.registry.get(h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID))[0]?.status,
      ).toBe("unknown");
    }),
  );

  it.effect("rolls back a definitive ordinary error", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.pin.run(h.registry, target);
      const request = yield* Queue.take(h.requests);
      yield* Deferred.fail(request.reply, new Error("Access changed"));

      expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
      expect(
        h.registry.get(h.commands.optimistic.entriesAtom(ENVIRONMENT_ID, THREAD_ID))[0]?.status,
      ).toBe("rejected");
    }),
  );
});
