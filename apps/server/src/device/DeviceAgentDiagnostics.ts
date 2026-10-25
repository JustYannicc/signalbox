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

interface SessionDiagnostic {
  readonly session: AgentDeviceSession;
  readonly commandGeneration: number;
  readonly failure: DeviceAgentCommandFailure | null;
}

interface DiagnosticsState {
  readonly nextGeneration: number;
  readonly sessions: ReadonlyMap<string, SessionDiagnostic>;
}

export class DeviceAgentDiagnostics extends Context.Service<
  DeviceAgentDiagnostics,
  {
    readonly beginCommand: (session: AgentDeviceSession) => Effect.Effect<number | null>;
    readonly recordFailure: (
      session: AgentDeviceSession,
      commandGeneration: number,
      input: DeviceAgentCommandFailureInput,
    ) => Effect.Effect<void>;
    readonly clearSessionFailure: (
      session: AgentDeviceSession,
      commandGeneration: number,
    ) => Effect.Effect<void>;
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
  stored: ReadonlyMap<string, SessionDiagnostic>,
): ReadonlyArray<DeviceAgentCommandFailure> =>
  Array.from(stored.values())
    .flatMap((entry) => {
      const live = findAgentDeviceSession(state, entry.session.sessionId);
      return entry.failure !== null && live !== null && sameAgentDeviceSession(entry.session, live)
        ? [entry.failure]
        : [];
    })
    .toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt));

const make = Effect.gen(function* () {
  const devices = yield* DeviceService.DeviceService;
  const scope = yield* Scope.Scope;
  const stateRef = yield* SynchronizedRef.make<DiagnosticsState>({
    nextGeneration: 0,
    sessions: new Map(),
  });
  const changes = yield* PubSub.unbounded<ReadonlyArray<DeviceAgentCommandFailure>>();

  const snapshot: DeviceAgentDiagnostics["Service"]["snapshot"] = Effect.gen(function* () {
    const state = yield* devices.state;
    const stored = yield* SynchronizedRef.get(stateRef);
    return visibleFailures(state, stored.sessions);
  });

  const publishSnapshot = snapshot.pipe(
    Effect.flatMap((failures) => PubSub.publish(changes, failures)),
    Effect.asVoid,
  );

  const removeStale = (deviceState: unknown) =>
    SynchronizedRef.modify(stateRef, (current) => {
      const sessions = new Map(
        Array.from(current.sessions).filter(([sessionId, entry]) => {
          const live = findAgentDeviceSession(deviceState, sessionId);
          return live !== null && sameAgentDeviceSession(entry.session, live);
        }),
      );
      return [sessions.size !== current.sessions.size, { ...current, sessions }] as const;
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

  const beginCommand: DeviceAgentDiagnostics["Service"]["beginCommand"] = Effect.fn(
    "DeviceAgentDiagnostics.beginCommand",
  )(function* (session) {
    if (!(yield* isLive(session))) return null;
    const generation = yield* SynchronizedRef.modify(stateRef, (current) => {
      const nextGeneration = current.nextGeneration + 1;
      const previous = current.sessions.get(session.sessionId);
      const retainedFailure =
        previous !== undefined && sameAgentDeviceSession(previous.session, session)
          ? previous.failure
          : null;
      const sessions = new Map(current.sessions).set(session.sessionId, {
        session,
        commandGeneration: nextGeneration,
        failure: retainedFailure,
      });
      return [nextGeneration, { nextGeneration, sessions }] as const;
    });
    if (yield* isLive(session)) return generation;

    yield* SynchronizedRef.update(stateRef, (current) => {
      const previous = current.sessions.get(session.sessionId);
      if (previous?.commandGeneration !== generation) return current;
      const sessions = new Map(current.sessions);
      sessions.delete(session.sessionId);
      return { ...current, sessions };
    });
    return null;
  });

  const recordFailure: DeviceAgentDiagnostics["Service"]["recordFailure"] = Effect.fn(
    "DeviceAgentDiagnostics.recordFailure",
  )(function* (session, commandGeneration, input) {
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
    const recorded = yield* SynchronizedRef.modify(stateRef, (current) => {
      const previous = current.sessions.get(session.sessionId);
      if (
        previous === undefined ||
        previous.commandGeneration !== commandGeneration ||
        !sameAgentDeviceSession(previous.session, session)
      ) {
        return [false, current] as const;
      }
      const sessions = new Map(current.sessions).set(session.sessionId, {
        ...previous,
        failure,
      });
      return [true, { ...current, sessions }] as const;
    });
    if (!recorded) return;

    if (!(yield* isLive(session))) {
      yield* SynchronizedRef.update(stateRef, (current) => {
        const previous = current.sessions.get(session.sessionId);
        if (previous?.commandGeneration !== commandGeneration) return current;
        const sessions = new Map(current.sessions);
        sessions.delete(session.sessionId);
        return { ...current, sessions };
      });
      return;
    }
    yield* publishSnapshot;
  });

  const clearSessionFailure: DeviceAgentDiagnostics["Service"]["clearSessionFailure"] = Effect.fn(
    "DeviceAgentDiagnostics.clearSessionFailure",
  )(function* (session, commandGeneration) {
    if (!(yield* isLive(session))) return;
    const cleared = yield* SynchronizedRef.modify(stateRef, (current) => {
      const previous = current.sessions.get(session.sessionId);
      if (
        previous === undefined ||
        previous.commandGeneration !== commandGeneration ||
        !sameAgentDeviceSession(previous.session, session) ||
        previous.failure === null
      ) {
        return [false, current] as const;
      }
      const sessions = new Map(current.sessions).set(session.sessionId, {
        ...previous,
        failure: null,
      });
      return [true, { ...current, sessions }] as const;
    });
    if (cleared) yield* publishSnapshot;
  });

  const subscribe = PubSub.subscribe(changes);

  return DeviceAgentDiagnostics.of({
    beginCommand,
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
