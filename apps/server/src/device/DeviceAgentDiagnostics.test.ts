import { describe, expect, it } from "@effect/vitest";
import {
  DeviceHostId,
  DeviceId,
  ProviderSessionId,
  ThreadId,
  type DeviceServiceState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DeviceAgentDiagnostics from "./DeviceAgentDiagnostics.ts";
import type { AgentDeviceSession } from "./AgentDeviceSession.ts";
import * as DeviceService from "./DeviceService.ts";

const session = (id: string, threadId = `thread-${id}`): AgentDeviceSession => ({
  sessionId: id,
  leaseId: `lease-${id}`,
  ownerKind: "agent",
  providerSessionId: ProviderSessionId.make(`provider-${id}`),
  threadId: ThreadId.make(threadId),
  hostId: DeviceHostId.make("local"),
  deviceId: DeviceId.make(`device-${id}`),
});

const stateWith = (sessions: ReadonlyArray<AgentDeviceSession>) =>
  ({ sessions }) as unknown as DeviceServiceState;

let setDeviceState: (state: DeviceServiceState) => Effect.Effect<void> = () => Effect.void;

const deviceLayer = Layer.effect(
  DeviceService.DeviceService,
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make(stateWith([]));
    const changes = yield* PubSub.unbounded<DeviceServiceState>();
    setDeviceState = (next) =>
      SynchronizedRef.set(state, next).pipe(
        Effect.flatMap(() => PubSub.publish(changes, next)),
        Effect.asVoid,
      );
    return DeviceService.DeviceService.of({
      state: SynchronizedRef.get(state),
      subscribe: PubSub.subscribe(changes),
    } as DeviceService.DeviceService["Service"]);
  }),
);

const testLayer = DeviceAgentDiagnostics.layer.pipe(Layer.provideMerge(deviceLayer));

describe("device agent diagnostics", () => {
  it.effect("keeps concurrent sessions separate and clears only the matching session", () =>
    Effect.gen(function* () {
      const first = session("session-1");
      const second = session("session-2");
      yield* setDeviceState(stateWith([first, second]));
      const diagnostics = yield* DeviceAgentDiagnostics.DeviceAgentDiagnostics;

      yield* diagnostics.recordFailure(first, {
        command: "press",
        message: "First command failed.",
      });
      yield* diagnostics.recordFailure(second, {
        command: "snapshot",
        message: "Second command failed.",
      });
      expect((yield* diagnostics.snapshot).map((failure) => failure.sessionId)).toEqual([
        "session-1",
        "session-2",
      ]);

      yield* diagnostics.clearSessionFailure(first);
      expect((yield* diagnostics.snapshot).map((failure) => failure.sessionId)).toEqual([
        "session-2",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not return diagnostics after a lease or provider session changes", () =>
    Effect.gen(function* () {
      const live = session("session-1");
      yield* setDeviceState(stateWith([live]));
      const diagnostics = yield* DeviceAgentDiagnostics.DeviceAgentDiagnostics;
      yield* diagnostics.recordFailure(live, {
        command: "press",
        message: "Runner failed.",
        diagnosticId: "diag-1",
      });
      expect(yield* diagnostics.snapshot).toHaveLength(1);

      yield* setDeviceState(stateWith([{ ...live, leaseId: "new-lease" }]));
      expect(yield* diagnostics.snapshot).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes an empty snapshot when the owning session closes", () =>
    Effect.gen(function* () {
      const live = session("session-1");
      yield* setDeviceState(stateWith([live]));
      const diagnostics = yield* DeviceAgentDiagnostics.DeviceAgentDiagnostics;
      const subscription = yield* diagnostics.subscribe;

      yield* diagnostics.recordFailure(live, {
        command: "press",
        message: "Runner failed.",
      });
      expect(
        Option.getOrNull(yield* Stream.runHead(Stream.fromSubscription(subscription))),
      ).toHaveLength(1);

      yield* setDeviceState(stateWith([]));
      expect(
        Option.getOrNull(yield* Stream.runHead(Stream.fromSubscription(subscription))),
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
