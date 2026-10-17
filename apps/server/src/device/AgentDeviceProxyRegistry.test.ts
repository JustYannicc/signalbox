import { describe, expect, it } from "@effect/vitest";
import { DeviceHostId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AgentDeviceProxyRegistry from "./AgentDeviceProxyRegistry.ts";

const endpoint = (sessionId: string) => ({
  sessionId,
  hostId: DeviceHostId.make("local"),
  configPath: `/state/${sessionId}.json`,
  proxyToken: `proxy-${sessionId}`,
  endpoint: {
    baseUrl: "http://127.0.0.1:43123",
    token: `daemon-${sessionId}`,
    entryPath: "/agent-device.mjs",
  },
});

describe("agent-device proxy registry", () => {
  it.effect("returns config files to remove when sessions end", () =>
    Effect.gen(function* () {
      const registry = yield* AgentDeviceProxyRegistry.AgentDeviceProxyRegistry;
      yield* registry.register(endpoint("session-1"));
      yield* registry.register(endpoint("session-2"));

      expect(yield* registry.retainSessions(new Set(["session-2"]))).toEqual([
        "/state/session-1.json",
      ]);
      expect(yield* registry.get("session-1")).toBeNull();
      expect(yield* registry.get("session-2")).toEqual(endpoint("session-2"));
    }).pipe(Effect.provide(AgentDeviceProxyRegistry.layer)),
  );
});
