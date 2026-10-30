import * as NodeAssert from "node:assert/strict";
import type { ClaudeSdkQuery } from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import type { ClaudeAgentSdkMcpServers } from "@signalbox/provider-claude/ClaudeQueryRunner";
import type { SdkSpawnedProcess } from "../../ClaudeIsolateAdapter.ts";

export type SDKUserMessage = Parameters<
  import("@signalbox/provider-claude/ClaudeQueryRunner").ClaudeAgentSdkQuerySession["offer"]
>[0];
export type SDKMessage = Exclude<Awaited<ReturnType<ClaudeSdkQuery["next"]>>["value"], void>;

export function sdkQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  child: SdkSpawnedProcess,
  installs: ClaudeAgentSdkMcpServers[],
  order: string[],
  offered: (message: SDKUserMessage) => void,
  initializationResult: ClaudeSdkQuery["initializationResult"],
  consumePrompt: boolean,
  frames?: () => AsyncIterable<SDKMessage>,
): ClaudeSdkQuery {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  if (consumePrompt)
    void (async () => {
      const first = await prompt[Symbol.asyncIterator]().next();
      NodeAssert.equal(first.done, false);
      if (first.value !== undefined) {
        order.push("prompt.offer");
        offered(first.value);
      }
    })();
  async function* messages(): AsyncGenerator<SDKMessage> {
    if (frames !== undefined) {
      yield* frames();
      return;
    }
    await closed;
    yield* [];
  }
  return Object.assign(messages(), {
    initializationResult,
    close: () => {
      order.push("query.close");
      finish();
      child.kill("SIGTERM");
    },
    setMcpServers: async (servers: ClaudeAgentSdkMcpServers) => {
      order.push("setMcpServers");
      installs.push(servers);
      return { added: Object.keys(servers), removed: [], errors: {} };
    },
    setModel: async (_model: string) => {},
    applyFlagSettings: async (_settings: Parameters<ClaudeSdkQuery["applyFlagSettings"]>[0]) => {},
    setPermissionMode: async (_mode: Parameters<ClaudeSdkQuery["setPermissionMode"]>[0]) => {},
    stopTask: async (_taskId: string) => {},
    backgroundTasks: async (_toolUseId: string) => true,
    interrupt: async () => undefined,
  }) satisfies ClaudeSdkQuery;
}

export function successfulResult(
  message: SDKUserMessage,
): Extract<SDKMessage, { type: "result"; subtype: "success" }> {
  if (message.uuid === undefined) throw new Error("The prompt has no native UUID");
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: "",
      iterations: [],
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
      speed: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    uuid: message.uuid,
    session_id: "sdk-session",
    user_message_uuid: message.uuid,
    terminal_reason: "completed",
  };
}
