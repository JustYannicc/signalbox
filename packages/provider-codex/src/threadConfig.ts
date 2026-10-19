import * as Schema from "effect/Schema";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

/**
 * Codex waits this long for MCP servers before the first model request and
 *   leaves out any server still starting (default 1 s, too short for cold
 *   `npx`/`uvx` servers).
 */
export const CODEX_THREAD_CONFIG = {
  "tools.update_plan.enabled": true,
  mcp_optional_startup_grace_ms: 10_000,
} as const;

// T3 wait tools can block for up to an hour. Keep Codex's MCP timeout above
// that limit so the server's own wait timeout ends a long call.
export const CODEX_T3_MCP_TOOL_TIMEOUT_SEC = 65 * 60;

export function codexThreadRuntimeParams(input: {
  readonly mcpSession: McpProviderSession.McpProviderSessionConfig | undefined;
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
  readonly modelSelection?: { readonly model: string };
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): {
  readonly cwd?: string;
  readonly model?: string;
  readonly config: Readonly<Record<string, Schema.Json>>;
} {
  const { mcpSession } = input;
  return {
    ...(input.runtimePolicy?.cwd == null ? {} : { cwd: input.runtimePolicy.cwd }),
    ...(input.modelSelection === undefined ? {} : { model: input.modelSelection.model }),
    config: {
      ...CODEX_THREAD_CONFIG,
      ...(input.mcpServers !== undefined
        ? {
            mcp_servers: Object.fromEntries(
              Object.entries(input.mcpServers).map(([name, server]) => [name, { url: server.url }]),
            ),
          }
        : mcpSession === undefined
          ? {}
          : {
              mcp_servers: {
                "t3-code": {
                  url: mcpSession.endpoint,
                  tool_timeout_sec: CODEX_T3_MCP_TOOL_TIMEOUT_SEC,
                  http_headers: {
                    Authorization: mcpSession.authorizationHeader,
                  },
                },
              },
            }),
    },
  };
}

export const decodeCodexResumeMetadata = Schema.decodeUnknownEffect(
  Schema.Struct({ thread: Schema.Struct({ id: Schema.String, updatedAt: Schema.Number }) }),
);

export const CodexChildSelection = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
  model: Schema.NullOr(Schema.String),
  reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
  serviceTier: Schema.optional(Schema.NullOr(Schema.String)),
});

export const decodeCodexChildModel = Schema.decodeUnknownEffect(CodexChildSelection);

export const decodeCodexChildThread = Schema.decodeUnknownEffect(
  Schema.Struct({
    thread: Schema.Struct({
      id: Schema.String,
      model: Schema.optional(Schema.NullOr(Schema.String)),
      reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
);
