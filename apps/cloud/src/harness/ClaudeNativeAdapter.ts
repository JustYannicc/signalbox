import type {
  ClaudeAgentSdkMcpServers,
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAgentSdkQuerySession,
} from "@signalbox/provider-claude/ClaudeQueryRunner";
import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { HarnessError, HarnessOpenInput } from "./Harness.ts";
import type { HarnessRuntimeReporter } from "./HarnessProcessLifetime.ts";

export type ClaudeNativeOpenInput = Pick<
  HarnessOpenInput,
  "release" | "session" | "checkpoint" | "creation" | "modelTransport"
>;

export interface ClaudeNativeMcpBridge {
  readonly resolveMcpServers: () => Effect.Effect<
    { readonly servers: ClaudeAgentSdkMcpServers; readonly signal: AbortSignal },
    ClaudeAgentSdkQueryRunnerError
  >;
  readonly opened: (session: ClaudeAgentSdkQuerySession) => void;
  readonly closed: (session: ClaudeAgentSdkQuerySession) => void;
}

export type ClaudeNativeAdapterFactory<
  Input extends ClaudeNativeOpenInput = ClaudeNativeOpenInput,
> = (mcp: ClaudeNativeMcpBridge) => {
  readonly open: (
    input: Input,
    reporter: HarnessRuntimeReporter,
  ) => Effect.Effect<
    ProviderAdapterV2SessionRuntime,
    HarnessError | ProviderAdapterV2Error,
    Scope.Scope
  >;
};
