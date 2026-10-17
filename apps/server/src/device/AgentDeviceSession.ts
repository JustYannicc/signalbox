import { DeviceHostId, DeviceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const AgentDeviceSession = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  leaseId: Schema.NonEmptyString,
  ownerKind: Schema.Literal("agent"),
  providerSessionId: ProviderSessionId,
  threadId: ThreadId,
  hostId: DeviceHostId,
  deviceId: DeviceId,
});

export type AgentDeviceSession = typeof AgentDeviceSession.Type;

const decodeAgentDeviceSession = Schema.decodeUnknownOption(AgentDeviceSession);

export const listAgentDeviceSessions = (state: unknown): ReadonlyArray<AgentDeviceSession> => {
  if (typeof state !== "object" || state === null || !("sessions" in state)) return [];
  const { sessions } = state;
  if (!Array.isArray(sessions)) return [];
  return sessions.flatMap((candidate) => {
    const decoded = Option.getOrNull(decodeAgentDeviceSession(candidate));
    return decoded ? [decoded] : [];
  });
};

export const findAgentDeviceSession = (state: unknown, sessionId: string) => {
  return listAgentDeviceSessions(state).find((session) => session.sessionId === sessionId) ?? null;
};

export const sameAgentDeviceSession = (left: AgentDeviceSession, right: AgentDeviceSession) =>
  left.sessionId === right.sessionId &&
  left.leaseId === right.leaseId &&
  left.ownerKind === right.ownerKind &&
  left.providerSessionId === right.providerSessionId &&
  left.threadId === right.threadId &&
  left.hostId === right.hostId &&
  left.deviceId === right.deviceId;
