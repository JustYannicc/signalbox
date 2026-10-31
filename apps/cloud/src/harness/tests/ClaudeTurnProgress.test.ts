import { describe, expect, it } from "@effect/vitest";
import type { ClaudeAgentSdkQueryOptions } from "@signalbox/provider-claude/ClaudeQueryRunner";
import {
  observeClaudeModelTransport,
  observeClaudeQueryOptions,
  observeClaudeMcpResponse,
} from "../ClaudeTurnProgress.ts";
import type { HarnessTurnStage } from "../HarnessTurnProgress.ts";

describe("Claude turn progress", () => {
  it.each(["application/json", "text/event-stream"])(
    "reports MCP initialization only after its real protocol reply is consumed via %s",
    async (contentType) => {
      const stages: HarnessTurnStage[] = [];
      const reply = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "fixture", version: "1" },
        },
      });
      const body =
        contentType === "application/json" ? reply : `event: message\ndata: ${reply}\n\n`;
      const response = observeClaudeMcpResponse(
        new Response(body, { headers: { "content-type": contentType } }),
        (stage) => stages.push(stage),
      );
      expect(stages).toEqual([]);
      expect(await response.text()).toBe(body);
      expect(stages).toEqual(["mcp-initialized"]);
    },
  );

  it("does not confuse MCP registration or listing with initialization, and bounds inspection", async () => {
    const stages: HarnessTurnStage[] = [];
    const bodies = [
      JSON.stringify({ added: ["executor"], errors: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "failed" } }),
      "x".repeat(40_000),
    ];
    for (const body of bodies) {
      const response = observeClaudeMcpResponse(new Response(body), (stage) => stages.push(stage));
      expect(await response.text()).toBe(body);
    }
    expect(stages).toEqual([]);
  });

  it("recognizes a split MCP SSE result while its stream stays open", async () => {
    const stages: HarnessTurnStage[] = [];
    const encoder = new TextEncoder();
    const parts = [
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18",',
      '"capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}',
      "\n\n",
    ];
    let index = 0;
    let cancelled = false;
    const response = observeClaudeMcpResponse(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const part = parts[index++];
              if (part !== undefined) controller.enqueue(encoder.encode(part));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      ),
      (stage) => stages.push(stage),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    expect(stages).toEqual([]);
    await reader.read();
    expect(stages).toEqual(["mcp-initialized"]);
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it("waits for a nonempty model byte, preserves backpressure and forwards cancellation", async () => {
    const stages: HarnessTurnStage[] = [];
    let reads = 0;
    let cancelled: unknown;
    const transport = observeClaudeModelTransport(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                reads++;
                controller.enqueue(reads === 1 ? new Uint8Array() : new Uint8Array([42]));
              },
              cancel(reason) {
                cancelled = reason;
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 201, headers: { "x-test": "preserved" } },
        ),
      (stage) => stages.push(stage),
    );
    const response = await transport(
      new Request("https://custom-model.test/prefix/v1/messages?beta=true", { method: "POST" }),
    );
    expect(stages).toEqual(["model-request-sent"]);
    expect(reads).toBe(0);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("preserved");
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array());
    expect(stages).toEqual(["model-request-sent"]);
    expect((await reader.read()).value).toEqual(new Uint8Array([42]));
    expect(stages).toEqual(["model-request-sent", "first-model-byte"]);
    await reader.cancel("owner ended");
    expect(cancelled).toBe("owner ended");
  });

  it("does not report MCP, token counting, or an empty model body as a first model byte", async () => {
    const stages: HarnessTurnStage[] = [];
    const transport = observeClaudeModelTransport(
      async () => new Response(null, { status: 204 }),
      (stage) => stages.push(stage),
    );
    await transport(
      new Request("https://harness-mcp.invalid/session/executor", { method: "POST" }),
    );
    await transport(
      new Request("https://api.anthropic.com/v1/messages/count_tokens", { method: "POST" }),
    );
    expect(stages).toEqual([]);
    await transport(new Request("https://api.anthropic.com/v1/messages", { method: "POST" }));
    expect(stages).toEqual(["model-request-sent"]);
  });

  it("reports an actual permission callback only and preserves its pending decision", async () => {
    const stages: HarnessTurnStage[] = [];
    const decision = Promise.withResolvers<{ behavior: "deny"; message: string }>();
    const options = observeClaudeQueryOptions(
      { permissionMode: "bypassPermissions", canUseTool: () => decision.promise },
      (stage) => stages.push(stage),
    );
    expect(stages).toEqual([]);
    const pending = options.canUseTool!(
      "Write",
      { file_path: "/work/test" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
        requestId: "permission-1",
      },
    );
    expect(stages).toEqual(["tool-permission-requested"]);
    const denied = { behavior: "deny" as const, message: "existing policy" };
    decision.resolve(denied);
    expect(await pending).toBe(denied);
    expect(stages).toEqual(["tool-permission-requested", "tool-permission-resolved"]);
    expect(options.permissionMode).toBe("bypassPermissions");
  });

  it("preserves existing hook decisions and reports both successful and failed tool completion", async () => {
    const stages: HarnessTurnStage[] = [];
    const blocked = { decision: "block" as const, reason: "existing hook" };
    const options = observeClaudeQueryOptions(
      { hooks: { PreToolUse: [{ hooks: [async () => blocked] }] } },
      (stage) => stages.push(stage),
    );
    type Hook = NonNullable<
      NonNullable<ClaudeAgentSdkQueryOptions["hooks"]>["PreToolUse"]
    >[number]["hooks"][number];
    const input = {
      hook_event_name: "PreToolUse" as const,
      session_id: "session",
      transcript_path: "/work/session",
      cwd: "/work",
      tool_name: "Write",
      tool_use_id: "tool-1",
      tool_input: {},
    };
    const invoke = (hook: Hook, value: Parameters<Hook>[0] = input) =>
      hook(value, "tool-1", { signal: new AbortController().signal });
    expect(await invoke(options.hooks.PreToolUse[0]!.hooks[0]!)).toBe(blocked);
    expect(await invoke(options.hooks.PreToolUse[1]!.hooks[0]!)).toEqual({});
    await invoke(options.hooks.PostToolUse[0]!.hooks[0]!, {
      ...input,
      hook_event_name: "PostToolUse",
      tool_response: {},
    });
    await invoke(options.hooks.PostToolUseFailure[0]!.hooks[0]!, {
      ...input,
      hook_event_name: "PostToolUseFailure",
      error: "failed",
      is_interrupt: false,
    });
    expect(stages).toEqual(["tool-call-started", "tool-call-ended", "tool-call-ended"]);
  });
});
