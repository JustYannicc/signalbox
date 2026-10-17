import { type DeviceAgentCommandFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DeviceService from "./DeviceService.ts";
import {
  findAgentDeviceSession,
  sameAgentDeviceSession,
  type AgentDeviceSession,
} from "./AgentDeviceSession.ts";

export interface DeviceAgentCommandFailureInput {
  readonly command: string;
  readonly message: string;
  readonly reason?: string | undefined;
  readonly hint?: string | undefined;
  readonly diagnosticId?: string | undefined;
  readonly logPath?: string | undefined;
}

interface StoredFailure {
  readonly session: AgentDeviceSession;
  readonly failure: DeviceAgentCommandFailure;
}

export class DeviceAgentDiagnostics extends Context.Service<
  DeviceAgentDiagnostics,
  {
    readonly recordFailure: (
      session: AgentDeviceSession,
      input: DeviceAgentCommandFailureInput,
    ) => Effect.Effect<void>;
    readonly clearSessionFailure: (session: AgentDeviceSession) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<ReadonlyArray<DeviceAgentCommandFailure>>;
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<ReadonlyArray<DeviceAgentCommandFailure>>,
      never,
      Scope.Scope
    >;
  }
>()("t3/device/DeviceAgentDiagnostics") {}

const visibleFailures = (
  state: unknown,
  stored: ReadonlyMap<string, StoredFailure>,
): ReadonlyArray<DeviceAgentCommandFailure> =>
  Array.from(stored.values())
    .filter((entry) => {
      const live = findAgentDeviceSession(state, entry.session.sessionId);
      return live !== null && sameAgentDeviceSession(entry.session, live);
    })
    .map((entry) => entry.failure)
    .toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt));

const make = Effect.gen(function* () {
  const devices = yield* DeviceService.DeviceService;
  const scope = yield* Scope.Scope;
  const failuresRef = yield* SynchronizedRef.make(new Map<string, StoredFailure>());
  const changes = yield* PubSub.unbounded<ReadonlyArray<DeviceAgentCommandFailure>>();

  const snapshot: DeviceAgentDiagnostics["Service"]["snapshot"] = Effect.gen(function* () {
    const state = yield* devices.state;
    const stored = yield* SynchronizedRef.get(failuresRef);
    return visibleFailures(state, stored);
  });

  const publishSnapshot = snapshot.pipe(
    Effect.flatMap((failures) => PubSub.publish(changes, failures)),
    Effect.asVoid,
  );

  const removeStale = (state: unknown) =>
    SynchronizedRef.modify(failuresRef, (stored) => {
      const retained = new Map(
        Array.from(stored).filter(([sessionId, entry]) => {
          const live = findAgentDeviceSession(state, sessionId);
          return live !== null && sameAgentDeviceSession(entry.session, live);
        }),
      );
      return [retained.size !== stored.size, retained] as const;
    }).pipe(Effect.flatMap((changed) => (changed ? publishSnapshot : Effect.void)));

  yield* DeviceService.stateStream(devices).pipe(
    Stream.runForEach(removeStale),
    Effect.forkIn(scope),
  );

  const isLive = (session: AgentDeviceSession) =>
    Effect.gen(function* () {
      const current = findAgentDeviceSession(yield* devices.state, session.sessionId);
      return current !== null && sameAgentDeviceSession(session, current);
    });

  const recordFailure: DeviceAgentDiagnostics["Service"]["recordFailure"] = Effect.fn(
    "DeviceAgentDiagnostics.recordFailure",
  )(function* (session, input) {
    if (!(yield* isLive(session))) return;
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    const failure: DeviceAgentCommandFailure = {
      sessionId: session.sessionId,
      threadId: session.threadId,
      hostId: session.hostId,
      deviceId: session.deviceId,
      command: input.command,
      message: input.message,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.hint !== undefined ? { hint: input.hint } : {}),
      ...(input.diagnosticId !== undefined ? { diagnosticId: input.diagnosticId } : {}),
      ...(input.logPath !== undefined ? { logPath: input.logPath } : {}),
      occurredAt,
    };
    yield* SynchronizedRef.update(failuresRef, (stored) =>
      new Map(stored).set(session.sessionId, { session, failure }),
    );
    if (!(yield* isLive(session))) {
      yield* SynchronizedRef.update(failuresRef, (stored) => {
        const next = new Map(stored);
        next.delete(session.sessionId);
        return next;
      });
      return;
    }
    yield* publishSnapshot;
  });

  const clearSessionFailure: DeviceAgentDiagnostics["Service"]["clearSessionFailure"] = Effect.fn(
    "DeviceAgentDiagnostics.clearSessionFailure",
  )(function* (session) {
    if (!(yield* isLive(session))) return;
    const stored = yield* SynchronizedRef.get(failuresRef);
    const previous = stored.get(session.sessionId);
    if (!previous || !sameAgentDeviceSession(previous.session, session)) return;
    yield* SynchronizedRef.update(failuresRef, (current) => {
      const next = new Map(current);
      next.delete(session.sessionId);
      return next;
    });
    yield* publishSnapshot;
  });

  const subscribe = PubSub.subscribe(changes);

  return DeviceAgentDiagnostics.of({
    recordFailure,
    clearSessionFailure,
    snapshot,
    subscribe,
  });
});

export const layer = Layer.effect(DeviceAgentDiagnostics, make);

export const stateStream = (
  service: DeviceAgentDiagnostics["Service"],
): Stream.Stream<ReadonlyArray<DeviceAgentCommandFailure>> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* service.subscribe;
      const initial = yield* service.snapshot;
      return Stream.concat(
        Stream.make(initial),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => service.snapshot)),
      );
    }),
  ).pipe(Stream.scoped);
