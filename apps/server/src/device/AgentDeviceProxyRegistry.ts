import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type { AgentDeviceEndpoint } from "./DeviceHost.ts";
import { sameAgentDeviceSession, type AgentDeviceSession } from "./AgentDeviceSession.ts";

export interface RegisteredAgentDeviceEndpoint {
  readonly registrationId: number;
  readonly session: AgentDeviceSession;
  readonly configPath: string;
  readonly proxyToken: string;
  readonly endpoint: AgentDeviceEndpoint;
}

export type AgentDeviceProxyRegistrationInput = Omit<
  RegisteredAgentDeviceEndpoint,
  "registrationId"
>;

interface RegistryState {
  readonly nextRegistrationId: number;
  readonly active: ReadonlyMap<string, RegisteredAgentDeviceEndpoint>;
  readonly pendingCleanup: ReadonlyMap<number, RegisteredAgentDeviceEndpoint>;
}

export class AgentDeviceProxyRegistry extends Context.Service<
  AgentDeviceProxyRegistry,
  {
    readonly register: (
      endpoint: AgentDeviceProxyRegistrationInput,
    ) => Effect.Effect<RegisteredAgentDeviceEndpoint>;
    readonly get: (sessionId: string) => Effect.Effect<RegisteredAgentDeviceEndpoint | null>;
    readonly isCurrent: (endpoint: RegisteredAgentDeviceEndpoint) => Effect.Effect<boolean>;
    readonly pruneSessions: <E>(
      liveSessions: ReadonlyMap<string, AgentDeviceSession>,
      removeConfig: (endpoint: RegisteredAgentDeviceEndpoint) => Effect.Effect<void, E>,
    ) => Effect.Effect<void, E>;
  }
>()("t3/device/AgentDeviceProxyRegistry") {}

const sameRegistration = (
  left: RegisteredAgentDeviceEndpoint,
  right: RegisteredAgentDeviceEndpoint,
) =>
  left.registrationId === right.registrationId &&
  left.proxyToken === right.proxyToken &&
  sameAgentDeviceSession(left.session, right.session);

const make = Effect.gen(function* () {
  const stateRef = yield* SynchronizedRef.make<RegistryState>({
    nextRegistrationId: 0,
    active: new Map(),
    pendingCleanup: new Map(),
  });

  const register: AgentDeviceProxyRegistry["Service"]["register"] = (input) =>
    SynchronizedRef.modify(stateRef, (state) => {
      const registrationId = state.nextRegistrationId + 1;
      const registration: RegisteredAgentDeviceEndpoint = { ...input, registrationId };
      const active = new Map(state.active);
      const pendingCleanup = new Map(state.pendingCleanup);
      const replaced = active.get(input.session.sessionId);
      if (replaced) pendingCleanup.set(replaced.registrationId, replaced);
      active.set(input.session.sessionId, registration);
      return [
        registration,
        { nextRegistrationId: registrationId, active, pendingCleanup },
      ] as const;
    });

  const get: AgentDeviceProxyRegistry["Service"]["get"] = (sessionId) =>
    SynchronizedRef.get(stateRef).pipe(Effect.map((state) => state.active.get(sessionId) ?? null));

  const isCurrent: AgentDeviceProxyRegistry["Service"]["isCurrent"] = (expected) =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.map((state) => {
        const current = state.active.get(expected.session.sessionId);
        return current !== undefined && sameRegistration(current, expected);
      }),
    );

  const pruneSessions: AgentDeviceProxyRegistry["Service"]["pruneSessions"] = (
    liveSessions,
    removeConfig,
  ) =>
    SynchronizedRef.modifyEffect(stateRef, (state) => {
      const staleActive = Array.from(state.active.values()).filter((registration) => {
        const live = liveSessions.get(registration.session.sessionId);
        return live === undefined || !sameAgentDeviceSession(registration.session, live);
      });
      const cleanup = [...state.pendingCleanup.values(), ...staleActive];
      if (cleanup.length === 0) return Effect.succeed([undefined, state] as const);

      return Effect.forEach(cleanup, removeConfig, { concurrency: 4, discard: true }).pipe(
        Effect.as([
          undefined,
          {
            ...state,
            active: new Map(
              Array.from(state.active).filter(
                ([, registration]) =>
                  !staleActive.some((stale) => sameRegistration(registration, stale)),
              ),
            ),
            pendingCleanup: new Map<number, RegisteredAgentDeviceEndpoint>(),
          },
        ] as const),
      );
    });

  return AgentDeviceProxyRegistry.of({ register, get, isCurrent, pruneSessions });
});

export const layer = Layer.effect(AgentDeviceProxyRegistry, make);
