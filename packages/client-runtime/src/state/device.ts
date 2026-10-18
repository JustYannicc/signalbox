import { type DeviceSession, type DeviceToolVersions, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function agentDeviceSessionIdForPanelSession(
  activeSession: DeviceSession | undefined,
  sessions: ReadonlyArray<DeviceSession>,
): string | null {
  if (!activeSession) return null;
  if ("ownerKind" in activeSession && activeSession.ownerKind === "agent") {
    return "sessionId" in activeSession && typeof activeSession.sessionId === "string"
      ? activeSession.sessionId
      : null;
  }
  if ("ownerKind" in activeSession && activeSession.ownerKind !== "panel") return null;
  if (!("leaseId" in activeSession) || typeof activeSession.leaseId !== "string") return null;

  const agentSession = sessions.find(
    (session) =>
      "ownerKind" in session &&
      session.ownerKind === "agent" &&
      "leaseId" in session &&
      session.leaseId === activeSession.leaseId &&
      session.threadId === activeSession.threadId &&
      session.hostId === activeSession.hostId &&
      session.deviceId === activeSession.deviceId,
  );
  return agentSession && "sessionId" in agentSession && typeof agentSession.sessionId === "string"
    ? agentSession.sessionId
    : null;
}

export function createDeviceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:device:state",
      tag: WS_METHODS.subscribeDeviceState,
    }),
    agentDiagnostics: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:device:agent-diagnostics",
      tag: WS_METHODS.subscribeDeviceAgentDiagnostics,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:configure",
      tag: WS_METHODS.deviceConfigure,
      scheduler,
      concurrency,
    }),
    testHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:test-host",
      tag: WS_METHODS.deviceTestHost,
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:list",
      tag: WS_METHODS.deviceList,
      scheduler,
      concurrency,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:open",
      tag: WS_METHODS.deviceOpen,
      scheduler,
      concurrency,
    }),
    // Cancellation must remain dispatchable while open is still running.
    cancelOpen: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:cancel-open",
      tag: WS_METHODS.deviceCancelOpen,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:close",
      tag: WS_METHODS.deviceClose,
      scheduler,
      concurrency,
    }),
    shutdown: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:shutdown",
      tag: WS_METHODS.deviceShutdown,
      scheduler,
      concurrency,
    }),
    detail: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:detail",
      tag: WS_METHODS.deviceDetail,
      scheduler,
      concurrency,
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:action",
      tag: WS_METHODS.deviceAction,
      scheduler,
      concurrency,
    }),
  };
}

export function deviceToolVersionLabels(tools: DeviceToolVersions | undefined) {
  if (!tools) return ["Device tool versions have not been checked."];
  return (
    [
      ["Device hub", tools.hub],
      ["Agent tools", tools.agent],
    ] as const
  ).map(([name, tool]) => {
    const installed = tool.installedVersions.length ? tool.installedVersions.join(", ") : "none";
    return `${name}: installed ${installed}; required ${tool.requiredVersion}${tool.runningVersion ? `; running ${tool.runningVersion}` : ""}.`;
  });
}

export function deviceToolUpdatePolicy(tools: DeviceToolVersions | undefined) {
  if (!tools) return "Versions have not been checked. Reconnect the host and check versions.";
  const outdated = [tools.hub, tools.agent].filter(
    (tool) =>
      tool.installedVersions.length > 0 && !tool.installedVersions.includes(tool.requiredVersion),
  );
  return outdated.length > 0
    ? "Update pending. Required tools will install automatically when next used. The host needs network access; an older install is not used as a fallback."
    : "Required tools are installed automatically when needed. Checking versions does not install or start anything.";
}
export const deviceToolUpdateOwnership =
  "This environment's Signalbox server chooses device tool versions for itself and its SSH hosts. Update that server to receive newer tool versions; updating only your browser or mobile app does not update a remote server.";
