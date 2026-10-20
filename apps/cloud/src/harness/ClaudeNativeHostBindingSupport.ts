import { stableStringify } from "@t3tools/shared/relaySigning";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type { ClaudeAgentSdkMcpServers } from "@signalbox/provider-claude/ClaudeQueryRunner";
import type { NativeMcpConfiguration, NativeThreadLoad } from "./HarnessSessionHost.ts";

export const requestedClaudeThread = (load: NativeThreadLoad) =>
  load.method === "ensureThread" ? load.input.existingProviderThread : load.input.providerThread;

export const claudeNativeLoadKey = (load: NativeThreadLoad) => {
  const requested = requestedClaudeThread(load);
  return stableStringify({
    method: load.method,
    threadId: load.input.threadId ?? requested?.appThreadId,
    providerSessionId:
      load.method === "ensureThread"
        ? (load.input.providerSessionId ?? requested?.providerSessionId)
        : requested?.providerSessionId,
    modelSelection: load.input.modelSelection,
    runtimePolicy: load.input.runtimePolicy,
    thread:
      requested === undefined
        ? undefined
        : {
            id: requested.id,
            driver: requested.driver,
            providerSessionId: requested.providerSessionId,
            providerInstanceId: requested.providerInstanceId,
            appThreadId: requested.appThreadId,
            nativeThreadRef: requested.nativeThreadRef,
          },
  });
};

export const claudeNativeSettingsKey = (modelSelection: unknown, runtimePolicy: unknown) =>
  stableStringify({ modelSelection, runtimePolicy });

export const sameClaudeThread = (
  a: OrchestrationV2ProviderThread,
  b: OrchestrationV2ProviderThread,
) =>
  a.id === b.id &&
  a.driver === b.driver &&
  a.providerSessionId === b.providerSessionId &&
  a.providerInstanceId === b.providerInstanceId &&
  a.appThreadId === b.appThreadId &&
  a.nativeThreadRef?.nativeId === b.nativeThreadRef?.nativeId &&
  a.nativeThreadRef?.strength === b.nativeThreadRef?.strength;

export const matchesRequestedClaudeThread = (
  loaded: OrchestrationV2ProviderThread,
  requested: OrchestrationV2ProviderThread,
) =>
  loaded.id === requested.id &&
  (requested.nativeThreadRef === null ||
    requested.nativeThreadRef === undefined ||
    requested.nativeThreadRef.nativeId === loaded.nativeThreadRef?.nativeId);

export function toClaudeMcpServers(
  configuration: NativeMcpConfiguration,
  origin: string,
): ClaudeAgentSdkMcpServers {
  const entries = Object.entries(configuration.servers).map(([name, server]) => {
    if (!name || new URL(server.url).origin !== origin)
      throw new Error("Native MCP URL is outside the supplied route.");
    return [name, Object.freeze({ type: "http" as const, url: server.url })] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}
