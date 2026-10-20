import type { ClaudeAgentSdkQueryOptions } from "@signalbox/provider-claude/ClaudeQueryRunner";
import type {
  ClaudeSdkQueryRunnerOptions,
  ClaudeSdkQuery,
} from "@signalbox/provider-claude/ClaudeSdkQueryRunner";

export type SdkSpawn = NonNullable<ClaudeAgentSdkQueryOptions["spawnClaudeCodeProcess"]>;
export type SdkSpawnOptions = Parameters<SdkSpawn>[0];
export type SdkSpawnedProcess = ReturnType<SdkSpawn>;

/** Actual exports of the prepared official npm package, after its host facades are installed. */
export interface PreparedClaudeSdk {
  readonly query: (input: Parameters<ClaudeSdkQueryRunnerOptions["query"]>[0]) => ClaudeSdkQuery;
  readonly forkSession: ClaudeSdkQueryRunnerOptions["forkSession"];
  readonly getSubagentMessages: (
    sessionId: string,
    agentId: string,
    options: { readonly dir?: string; readonly limit: number },
  ) => Promise<ReadonlyArray<{ readonly parent_tool_use_id: string | null }>>;
}
