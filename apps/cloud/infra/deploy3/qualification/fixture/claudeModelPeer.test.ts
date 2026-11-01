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
      input: { operation: "echo", input: { items: [{ first: 1, second: 2 }, [true, false]] } },
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
    if (call?.input !== undefined) {
      const reorder = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(reorder);
        if (value !== null && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value)
              .toReversed()
              .map(([key, item]) => [key, reorder(item)]),
          );
        return value;
      };
      call.input = reorder(call.input);
    }
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

async function completedEditHistory(input: unknown) {
  const peer = new ClaudeQualificationModelPeer({
    model,
    collectorNonce,
    mcpProbe: {
      toolName: "mcp__executor__signalbox_call",
      input: { operation: "echo", input: {} },
      expectedText: "MCP result",
    },
  });
  const messages: unknown[] = [{ role: "user", content: CLAUDE_QUALIFICATION_PROMPTS.work }];
  for (const [index, name] of ["Write", "Read", "Edit"].entries()) {
    const message = (await (await peer.fetch(post(body(messages, mcpTools())))).json()) as {
      content: Array<{ type: string; id?: string; input?: unknown }>;
    };
    const use = message.content.find((part) => part.type === "tool_use")!;
    if (name === "Edit") use.input = input;
    messages.push({ role: "assistant", content: message.content });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: use.id, content: index === 1 ? "before\n" : "Success" },
      ],
    });
  }
  return { peer, request: post(body(messages, mcpTools())) };
}

it("accepts the retained SDK Edit default and reordered frozen keys", async () => {
  const { peer, request } = await completedEditHistory({
    replace_all: false,
    new_string: "after",
    file_path: "/workspace/claude-qualification.txt",
    old_string: "before",
  });
  const response = await peer.fetch(request);
  expect(await response.json()).toMatchObject({ content: [{ name: "Bash" }] });
  expect(peer.snapshot().toolEvidence.map((item) => item.name)).toEqual(["Write", "Read", "Edit"]);
});

it.each([
  {
    replace_all: true,
    file_path: "/workspace/claude-qualification.txt",
    old_string: "before",
    new_string: "after",
  },
  {
    unknown: false,
    file_path: "/workspace/claude-qualification.txt",
    old_string: "before",
    new_string: "after",
  },
  { file_path: "/workspace/claude-qualification.txt", old_string: "before" },
  {
    file_path: "/workspace/claude-qualification.txt",
    old_string: "different",
    new_string: "after",
  },
])("rejects an Edit input that changes the frozen action: %j", async (input) => {
  const { peer, request } = await completedEditHistory(input);
  await expect(peer.fetch(request)).rejects.toThrow("differs from its frozen action");
  expect(peer.snapshot().toolEvidence.map((item) => item.name)).toEqual(["Write", "Read"]);
});
