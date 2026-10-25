import type {
  Options as ClaudeQueryOptions,
  Query as ClaudeQuery,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  ForkSessionOptions,
  ForkSessionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadId, OrchestrationV2ProviderSession } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ClaudeFlagSettings = Parameters<ClaudeQuery["applyFlagSettings"]>[0];
export type ClaudeAgentSdkQueryToolList = ReadonlyArray<string>;
export interface ClaudeAgentSdkQueryPresetTools {
  readonly type: "preset";
  readonly preset: "claude_code";
}
export type ClaudeAgentSdkQueryTools = ClaudeAgentSdkQueryToolList | ClaudeAgentSdkQueryPresetTools;

export const CLAUDE_READ_ONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;
export type ClaudeAgentSdkThreadIdentity =
  | {
      readonly sessionId: string;
      readonly resume?: never;
    }
  | {
      readonly sessionId?: never;
      readonly resume: string;
    };

export type ClaudeAgentSdkQueryOptions = Omit<
  ClaudeQueryOptions,
  "maxTurns" | "model" | "permissionMode" | "resume" | "sessionId" | "tools"
> & {
  readonly model: string;
  readonly tools: NonNullable<ClaudeQueryOptions["tools"]>;
  readonly permissionMode: NonNullable<ClaudeQueryOptions["permissionMode"]>;
} & ClaudeAgentSdkThreadIdentity;

export type ClaudeAgentSdkMcpServers = NonNullable<ClaudeAgentSdkQueryOptions["mcpServers"]>;

export interface ClaudeAgentSdkQueryOpenInput {
  readonly options: ClaudeAgentSdkQueryOptions;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

export interface ClaudeAgentSdkQuerySession {
  readonly messages: Stream.Stream<SDKMessage, ClaudeAgentSdkQueryRunnerError>;
  readonly offer: (message: SDKUserMessage) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  /** Strictly installs the supplied map on this retained native Query; an empty map clears it. */
  readonly configureMcp?: (
    servers: ClaudeAgentSdkMcpServers,
    signal: AbortSignal,
  ) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly setModel: (model: string) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly applyFlagSettings: (
    settings: ClaudeFlagSettings,
  ) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly setPermissionMode: (
    mode: PermissionMode,
  ) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly stopTask: (taskId: string) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly backgroundTasks: (
    toolUseId: string,
  ) => Effect.Effect<boolean, ClaudeAgentSdkQueryRunnerError>;
  readonly interrupt: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly close: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
}

export class ClaudeAgentSdkQueryRunnerError extends Schema.TaggedError<ClaudeAgentSdkQueryRunnerError>()(
  "ClaudeAgentSdkQueryRunnerError",
  {
    method: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Claude Agent SDK query failed.";
  }
}

export interface ClaudeAgentSdkQueryRunnerShape {
  readonly allocateSessionId: Effect.Effect<string, ClaudeAgentSdkQueryRunnerError>;
  readonly open: (
    input: ClaudeAgentSdkQueryOpenInput,
  ) => Effect.Effect<ClaudeAgentSdkQuerySession, ClaudeAgentSdkQueryRunnerError>;
  readonly forkSession: (
    input: ClaudeAgentSdkSessionForkInput,
  ) => Effect.Effect<ForkSessionResult, ClaudeAgentSdkQueryRunnerError>;
  readonly subagentLaunchToolUseId: (
    input: ClaudeAgentSdkSubagentLookupInput,
  ) => Effect.Effect<string | null, ClaudeAgentSdkQueryRunnerError>;
  readonly assertComplete: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
}

export class ClaudeAgentSdkQueryRunner extends Context.Service<
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerShape
>()("@signalbox/provider-claude/ClaudeQueryRunner/ClaudeAgentSdkQueryRunner") {}

export interface ClaudeAgentSdkSessionForkInput {
  readonly sessionId: string;
  readonly options: ForkSessionOptions;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

export interface ClaudeAgentSdkSubagentLookupInput {
  readonly sessionId: string;
  readonly agentId: string;
  readonly dir: string | null;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}
