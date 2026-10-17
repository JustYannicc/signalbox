import { describe, expect, it } from "@effect/vitest";
import { DeviceHostId, DeviceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { AgentDeviceSession } from "./AgentDeviceSession.ts";
import * as AgentDeviceProxyRegistry from "./AgentDeviceProxyRegistry.ts";

const session = (
  sessionId: string,
  providerSessionId = `provider-${sessionId}`,
): AgentDeviceSession => ({
  sessionId,
  leaseId: `lease-${sessionId}`,
  ownerKind: "agent",
  providerSessionId: ProviderSessionId.make(providerSessionId),
  threadId: ThreadId.make(`thread-${sessionId}`),
  hostId: DeviceHostId.make("local"),
  deviceId: DeviceId.make(`device-${sessionId}`),
  platform: "ios",
});

const endpoint = (current: AgentDeviceSession, proxyToken = `proxy-${current.sessionId}`) => ({
  session: current,
  configPath: `/state/${current.sessionId}-${proxyToken}.json`,
  proxyToken,
  endpoint: {
    baseUrl: "http://127.0.0.1:43123",
    token: `daemon-${current.sessionId}`,
    entryPath: "/agent-device.mjs",
  },
});

describe("agent-device proxy registry", () => {
  it.effect("keeps active registrations and removes stale configs", () =>
    Effect.gen(function* () {
      const registry = yield* AgentDeviceProxyRegistry.AgentDeviceProxyRegistry;
      const first = yield* registry.register(endpoint(session("session-1")));
      const second = yield* registry.register(endpoint(session("session-2")));
      const removed: Array<string> = [];

      yield* registry.pruneSessions(
        new Map([[second.session.sessionId, second.session]]),
        (registration) => Effect.sync(() => void removed.push(registration.configPath)),
      );

      expect(removed).toEqual([first.configPath]);
      expect(yield* registry.get("session-1")).toBeNull();
      expect(yield* registry.get("session-2")).toEqual(second);
    }).pipe(Effect.provide(AgentDeviceProxyRegistry.layer)),
  );

  it.effect("keeps a failed config deletion registered so the next pass can retry", () =>
    Effect.gen(function* () {
      const registry = yield* AgentDeviceProxyRegistry.AgentDeviceProxyRegistry;
      const registration = yield* registry.register(endpoint(session("session-1")));
      const failed = yield* registry
        .pruneSessions(new Map(), () => Effect.fail("disk is busy"))
        .pipe(
          Effect.as(false),
          Effect.catch(() => Effect.succeed(true)),
        );
      expect(failed).toBe(true);
      expect(yield* registry.get("session-1")).toEqual(registration);

      const removed: Array<string> = [];
      yield* registry.pruneSessions(new Map(), (current) =>
        Effect.sync(() => void removed.push(current.configPath)),
      );
      expect(removed).toEqual([registration.configPath]);
      expect(yield* registry.get("session-1")).toBeNull();
    }).pipe(Effect.provide(AgentDeviceProxyRegistry.layer)),
  );

  it.effect("fences new registrations and cleans the replaced config", () =>
    Effect.gen(function* () {
      const registry = yield* AgentDeviceProxyRegistry.AgentDeviceProxyRegistry;
      const oldSession = session("session-1", "provider-old");
      const nextSession = session("session-1", "provider-new");
      const oldRegistration = yield* registry.register(endpoint(oldSession, "old-token"));
      const nextRegistration = yield* registry.register(endpoint(nextSession, "new-token"));
      const removed: Array<string> = [];

      expect(yield* registry.isCurrent(oldRegistration)).toBe(false);
      expect(yield* registry.isCurrent(nextRegistration)).toBe(true);
      yield* registry.pruneSessions(
        new Map([[nextSession.sessionId, nextSession]]),
        (registration) => Effect.sync(() => void removed.push(registration.configPath)),
      );

      expect(removed).toEqual([oldRegistration.configPath]);
      expect(yield* registry.isCurrent(nextRegistration)).toBe(true);
    }).pipe(Effect.provide(AgentDeviceProxyRegistry.layer)),
  );

  it.effect("invalidates a registration when its lease generation changes", () =>
    Effect.gen(function* () {
      const registry = yield* AgentDeviceProxyRegistry.AgentDeviceProxyRegistry;
      const previous = session("session-1");
      const replacement = { ...previous, leaseId: "replacement-lease" };
      const previousRegistration = yield* registry.register(endpoint(previous, "old-token"));
      const replacementRegistration = yield* registry.register(endpoint(replacement, "new-token"));
      const removed: Array<string> = [];

      expect(yield* registry.isCurrent(previousRegistration)).toBe(false);
      expect(yield* registry.isCurrent(replacementRegistration)).toBe(true);
      yield* registry.pruneSessions(
        new Map([[replacement.sessionId, replacement]]),
        (registration) => Effect.sync(() => void removed.push(registration.configPath)),
      );

      expect(removed).toEqual([previousRegistration.configPath]);
      expect(yield* registry.get(replacement.sessionId)).toEqual(replacementRegistration);
    }).pipe(Effect.provide(AgentDeviceProxyRegistry.layer)),
  );
});
