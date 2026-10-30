import { expect, it } from "vite-plus/test";
import { CLAUDE_QUALIFICATION_PROMPTS, ClaudeQualificationModelPeer } from "./claudeModelPeer.ts";

const model = "claude-sonnet-4-6";
const collectorNonce = "collector-nonce-test";

function body(messages: readonly unknown[], tools?: readonly unknown[]) {
  return {
    model,
    max_tokens: 128,
    stream: false,
    messages,
    ...(tools === undefined ? {} : { tools }),
  };
}

function post(input: unknown, signal?: AbortSignal) {
  return new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    ...(signal === undefined ? {} : { signal }),
  });
}

function mcpTools() {
  return [
    {
      name: "mcp__executor__signalbox_call",
      input_schema: {
        type: "object",
        properties: {
          operation: { type: "string" },
          input: { type: "object", properties: {}, required: [] },
        },
        required: ["operation", "input"],
      },
    },
  ];
}

it("requires and records each real Messages tool result in the frozen order", async () => {
  const peer = new ClaudeQualificationModelPeer({
    model,
    collectorNonce,
    mcpProbe: {
      toolName: "mcp__executor__signalbox_call",
      input: { operation: "echo", input: {} },
      expectedText: "MCP result",
    },
  });
  const messages: unknown[] = [
    { role: "user", content: [{ type: "text", text: CLAUDE_QUALIFICATION_PROMPTS.work }] },
  ];
  const expected = ["Write", "Read", "Edit", "Bash", "Grep", "mcp__executor__signalbox_call"];
  const outputFor = [
    "Success",
    "before\n",
    "Updated",
    "sb1070-claude-bash-marker\n",
    "/workspace/claude-qualification.txt:1:after\n",
    "MCP result",
  ];

  for (let index = 0; index < expected.length; index++) {
    const response = await peer.fetch(post(body(messages, mcpTools())));
    const message = (await response.json()) as {
      content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
    };
    const call = message.content.find((part) => part.type === "tool_use");
    expect(call?.name).toBe(expected[index]);
    messages.push({ role: "assistant", content: message.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: call?.id,
          content: [{ type: "text", text: outputFor[index] }],
        },
      ],
    });
  }

  const final = await peer.fetch(post(body(messages, mcpTools())));
  expect(await final.json()).toMatchObject({
    content: [{ type: "text", text: "sb1070-claude-workflow-complete" }],
    stop_reason: "end_turn",
  });
  expect(peer.snapshot()).toMatchObject({
    collectorNonce,
    workCompleted: true,
    toolEvidence: expected.map((name) => ({ name })),
  });
});

it("serves two completed turns after the completed-checkpoint replacement", async () => {
  const peer = new ClaudeQualificationModelPeer({ model, collectorNonce });
  for (const [phase, text] of [
    ["resume", "sb1070-claude-resume-observed"],
    ["finish", "sb1070-claude-three-turns-complete"],
  ] as const) {
    const response = await peer.fetch(
      post(body([{ role: "user", content: CLAUDE_QUALIFICATION_PROMPTS[phase] }])),
    );
    expect(await response.json()).toMatchObject({
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    });
  }
  expect(peer.snapshot()).toMatchObject({ resumeCompleted: true, finishCompleted: true });
});

it("does not admit a turn with the retired interrupt prompt", async () => {
  const peer = new ClaudeQualificationModelPeer({ model, collectorNonce });
  await expect(
    peer.fetch(post(body([{ role: "user", content: "SB1070-CLAUDE-INTERRUPT-01" }]))),
  ).rejects.toThrow("missing its frozen prompt marker");
});
