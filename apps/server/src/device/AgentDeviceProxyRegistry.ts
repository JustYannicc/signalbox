import type { DeviceHostId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type { AgentDeviceEndpoint } from "./DeviceHost.ts";

export interface RegisteredAgentDeviceEndpoint {
  readonly sessionId: string;
  readonly hostId: DeviceHostId;
  readonly configPath: string;
  readonly proxyToken: string;
  readonly endpoint: AgentDeviceEndpoint;
}

export class AgentDeviceProxyRegistry extends Context.Service<
  AgentDeviceProxyRegistry,
  {
    readonly register: (endpoint: RegisteredAgentDeviceEndpoint) => Effect.Effect<void>;
    readonly get: (sessionId: string) => Effect.Effect<RegisteredAgentDeviceEndpoint | null>;
    readonly retainSessions: (
      sessionIds: ReadonlySet<string>,
    ) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/device/AgentDeviceProxyRegistry") {}

const make = Effect.gen(function* () {
  const endpointsRef = yield* SynchronizedRef.make(
    new Map<string, RegisteredAgentDeviceEndpoint>(),
  );

  const register: AgentDeviceProxyRegistry["Service"]["register"] = Effect.fn(
    "AgentDeviceProxyRegistry.register",
  )(function* (endpoint) {
    yield* SynchronizedRef.update(endpointsRef, (endpoints) =>
      new Map(endpoints).set(endpoint.sessionId, endpoint),
    );
  });

  const get: AgentDeviceProxyRegistry["Service"]["get"] = (sessionId) =>
    SynchronizedRef.get(endpointsRef).pipe(
      Effect.map((endpoints) => endpoints.get(sessionId) ?? null),
    );

  const retainSessions: AgentDeviceProxyRegistry["Service"]["retainSessions"] = (sessionIds) =>
    SynchronizedRef.modify(endpointsRef, (endpoints) => {
      const retained = new Map<string, RegisteredAgentDeviceEndpoint>();
      const staleConfigs: Array<string> = [];
      for (const [sessionId, endpoint] of endpoints) {
        if (sessionIds.has(sessionId)) retained.set(sessionId, endpoint);
        else staleConfigs.push(endpoint.configPath);
      }
      return [staleConfigs, retained] as const;
    });

  return AgentDeviceProxyRegistry.of({ register, get, retainSessions });
});

export const layer = Layer.effect(AgentDeviceProxyRegistry, make);
