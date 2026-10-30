import { decodeClaudeMcpProbe, type ClaudeMcpProbe } from "./claudeMcpProbe.ts";
export const CLAUDE_QUALIFICATION_PROMPTS = {
  work: "SB1070-CLAUDE-WORK-01",
  finish: "SB1070-CLAUDE-FINISH-01",
  resume: "SB1070-CLAUDE-RESUME-01",
} as const;

const WORKSPACE_FILE = "/workspace/claude-qualification.txt";
const BASH_MARKER = "sb1070-claude-bash-marker";
const FINAL_TEXT = "sb1070-claude-workflow-complete";
const RESUME_TEXT = "sb1070-claude-resume-observed";
const encoder = new TextEncoder();

type ToolResult = {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: unknown;
  readonly is_error?: boolean;
};
type ToolUse = {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
};
type ContentBlock = { readonly type: "text"; readonly text: string } | ToolUse;
type MessagesBody = {
  readonly model?: unknown;
  readonly stream?: unknown;
  readonly messages?: unknown;
  readonly tools?: unknown;
};

interface Action {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly verify: (result: ToolResult) => void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

function allToolUses(messages: readonly unknown[]): ToolUse[] {
  return messages.flatMap((message) => {
    const content = record(message)?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
      const item = record(block);
      if (
        item?.type !== "tool_use" ||
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        record(item.input) === undefined
      )
        return [];
      return [item as unknown as ToolUse];
    });
  });
}

function allToolResults(messages: readonly unknown[]): ToolResult[] {
  return messages.flatMap((message) => {
    if (record(message)?.role !== "user") return [];
    const content = record(message)?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
      const item = record(block);
      if (item?.type !== "tool_result" || typeof item.tool_use_id !== "string") return [];
      return [item as unknown as ToolResult];
    });
  });
}

function tools(body: MessagesBody): readonly Record<string, unknown>[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools
    .map(record)
    .filter((item): item is Record<string, unknown> => item !== undefined);
}

function mcpAction(body: MessagesBody, probe: ClaudeMcpProbe | undefined): Action {
  if (!probe) throw new Error("CLAUDE_QUALIFICATION_MCP_PROBE_REQUIRED");
  const tool = tools(body).find((tool) => tool.name === probe.toolName);
  if (!tool) throw new Error("CLAUDE_QUALIFICATION_EXECUTOR_MCP_TOOL_MISSING");
  return {
    name: probe.toolName,
    input: probe.input,
    verify(result) {
      if (result.is_error === true || textContent(result.content) !== probe.expectedText)
        throw new Error("CLAUDE_QUALIFICATION_EXECUTOR_MCP_RESULT_INVALID");
    },
  };
}

function workActions(body: MessagesBody, probe: ClaudeMcpProbe | undefined): Action[] {
  return [
    {
      name: "Write",
      input: { file_path: WORKSPACE_FILE, content: "before\n" },
      verify(result) {
        if (result.is_error === true || textContent(result.content).trim() === "")
          throw new Error("CLAUDE_QUALIFICATION_WRITE_RESULT_INVALID");
      },
    },
    {
      name: "Read",
      input: { file_path: WORKSPACE_FILE },
      verify(result) {
        if (result.is_error === true || !textContent(result.content).includes("before"))
          throw new Error("CLAUDE_QUALIFICATION_READ_RESULT_INVALID");
      },
    },
    {
      name: "Edit",
      input: { file_path: WORKSPACE_FILE, old_string: "before", new_string: "after" },
      verify(result) {
        if (result.is_error === true || textContent(result.content).trim() === "")
          throw new Error("CLAUDE_QUALIFICATION_EDIT_RESULT_INVALID");
      },
    },
    {
      name: "Bash",
      input: { command: `printf '%s\\n' ${BASH_MARKER}` },
      verify(result) {
        if (result.is_error === true || !textContent(result.content).includes(BASH_MARKER))
          throw new Error("CLAUDE_QUALIFICATION_BASH_RESULT_INVALID");
      },
    },
    {
      name: "Grep",
      input: { pattern: "after", path: WORKSPACE_FILE },
      verify(result) {
        const text = textContent(result.content);
        if (result.is_error === true || !text.includes("after") || !text.includes(WORKSPACE_FILE))
          throw new Error("CLAUDE_QUALIFICATION_GREP_RESULT_INVALID");
      },
    },
    mcpAction(body, probe),
  ];
}

function currentPrompt(messages: readonly unknown[]): string {
  return messages
    .filter((message) => record(message)?.role === "user")
    .map((message) => textContent(record(message)?.content))
    .join("\n");
}

function jsonResponse(body: unknown, requestId: string): Response {
  return Response.json(body, {
    headers: { "request-id": requestId, "anthropic-version": "2023-06-01" },
  });
}

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function streamingResponse(
  message: Record<string, unknown>,
  content: readonly ContentBlock[],
): Response {
  const usage = record(message.usage) ?? { input_tokens: 1, output_tokens: 1 };
  const events = [
    event("message_start", {
      message: {
        ...message,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    }),
  ];
  for (const [index, block] of content.entries()) {
    if (block.type === "text") {
      events.push(
        event("content_block_start", { index, content_block: { type: "text", text: "" } }),
      );
      events.push(
        event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }),
      );
    } else {
      events.push(
        event("content_block_start", {
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        }),
      );
      events.push(
        event("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        }),
      );
    }
    events.push(event("content_block_stop", { index }));
  }
  events.push(
    event("message_delta", {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    }),
  );
  events.push(event("message_stop", {}));
  return new Response(events.join(""), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "request-id": String(message.id),
      "anthropic-version": "2023-06-01",
    },
  });
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(encoder.encode(JSON.stringify(value)).byteLength / 4));
}

function makeMessage(
  body: MessagesBody,
  ordinal: number,
  content: readonly ContentBlock[],
  stopReason: "tool_use" | "end_turn",
) {
  const model = typeof body.model === "string" ? body.model : "";
  return {
    id: `msg_sb1070_claude_${ordinal}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: estimateTokens(body), output_tokens: estimateTokens(content) },
  };
}

/** A deterministic Anthropic Messages peer. It never falls through to a real network model. */
export class ClaudeQualificationModelPeer {
  readonly #model: string;
  readonly #nonce: string;
  #ordinal = 0;
  #requests = 0;
  #finishCompleted = false;
  #toolEvidence = new Map<
    string,
    {
      readonly ordinal: number;
      readonly name: string;
      readonly toolUseId: string;
      readonly resultText: string;
    }
  >();
  #workCompleted = false;
  #resumeCompleted = false;

  readonly #probe: ClaudeMcpProbe | undefined;
  constructor(input: {
    readonly model: string;
    readonly collectorNonce: string;
    readonly mcpProbe?: ClaudeMcpProbe;
  }) {
    if (!input.model.trim() || !input.collectorNonce.trim())
      throw new TypeError("Claude model peer identity is incomplete.");
    this.#probe = input.mcpProbe === undefined ? undefined : decodeClaudeMcpProbe(input.mcpProbe);
    this.#model = input.model;
    this.#nonce = input.collectorNonce;
  }

  async fetch(request: Request): Promise<Response> {
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      (url.pathname !== "/v1/messages" && url.pathname !== "/v1/messages/count_tokens")
    )
      throw new Error("Claude model peer admits only the Messages endpoint.");
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await request.clone().arrayBuffer()),
    ) as MessagesBody;
    if (body.model !== this.#model)
      throw new Error("Claude Messages request identity or conversation is invalid.");
    if (url.pathname === "/v1/messages/count_tokens")
      return jsonResponse(
        { input_tokens: estimateTokens(body) },
        `req_sb1070_claude_count_${++this.#ordinal}`,
      );
    if (!Array.isArray(body.messages) || body.messages.length === 0)
      throw new Error("Claude Messages request identity or conversation is invalid.");

    const messages = body.messages;
    const prompt = currentPrompt(messages);
    const ordinal = ++this.#ordinal;
    this.#requests++;
    if (prompt.includes(CLAUDE_QUALIFICATION_PROMPTS.finish)) {
      this.#finishCompleted = true;
      const content = [{ type: "text", text: "sb1070-claude-three-turns-complete" }] as const;
      const response = makeMessage(body, ordinal, content, "end_turn");
      return body.stream === true
        ? streamingResponse(response, content)
        : jsonResponse(response, `req_sb1070_claude_${ordinal}`);
    }
    if (prompt.includes(CLAUDE_QUALIFICATION_PROMPTS.resume)) {
      this.#resumeCompleted = true;
      const content = [{ type: "text", text: RESUME_TEXT }] as const;
      const response = makeMessage(body, ordinal, content, "end_turn");
      return body.stream === true
        ? streamingResponse(response, content)
        : jsonResponse(response, `req_sb1070_claude_${ordinal}`);
    }
    if (!prompt.includes(CLAUDE_QUALIFICATION_PROMPTS.work))
      throw new Error("Claude workload turn is missing its frozen prompt marker.");

    const actions = workActions(body, this.#probe);
    const uses = allToolUses(messages);
    const results = allToolResults(messages);
    if (uses.length !== results.length + 1 && uses.length !== results.length)
      throw new Error("Claude workload tool-use/result history has a gap.");
    for (let index = 0; index < results.length; index++) {
      const action = actions[index];
      if (!action) throw new Error("Claude workload sent an undeclared tool result.");
      const use = uses[index];
      const id = `toolu_sb1070_claude_${index + 1}`;
      const matching = results.filter((candidate) => candidate.tool_use_id === id);
      if (matching.length !== 1) throw new Error("CLAUDE_QUALIFICATION_TOOL_RESULT_MISSING");
      action.verify(matching[0]!);
      if (
        use?.id !== id ||
        use.name !== action.name ||
        JSON.stringify(use.input) !== JSON.stringify(action.input) ||
        matching[0]!.tool_use_id !== use.id
      )
        throw new Error("Claude workload tool call differs from its frozen action.");
      this.#toolEvidence.set(use.id, {
        ordinal: index + 1,
        name: action.name,
        toolUseId: use.id,
        resultText: textContent(matching[0]!.content),
      });
    }

    const nextIndex = results.length;
    const action = actions[nextIndex];
    const content: ContentBlock[] = [];
    if (nextIndex === 0)
      content.push({ type: "text", text: "I will create, edit, inspect, and verify the file." });
    if (action) {
      content.push({
        type: "tool_use",
        id: `toolu_sb1070_claude_${nextIndex + 1}`,
        name: action.name,
        input: action.input,
      });
      const response = makeMessage(body, ordinal, content, "tool_use");
      return body.stream === true
        ? streamingResponse(response, content)
        : jsonResponse(response, `req_sb1070_claude_${ordinal}`);
    }

    content.push({ type: "text", text: FINAL_TEXT });
    this.#workCompleted = true;
    const response = makeMessage(body, ordinal, content, "end_turn");
    return body.stream === true
      ? streamingResponse(response, content)
      : jsonResponse(response, `req_sb1070_claude_${ordinal}`);
  }

  snapshot() {
    return {
      purpose: "qualification" as const,
      apiRevision: "EC1APIr2" as const,
      collectorNonce: this.#nonce,
      model: this.#model,
      requests: this.#requests,
      finishCompleted: this.#finishCompleted,
      workCompleted: this.#workCompleted,
      resumeCompleted: this.#resumeCompleted,
      toolEvidence: [...this.#toolEvidence.values()].map((entry) => ({ ...entry })),
      nativeQualification: false as const,
    };
  }
}
