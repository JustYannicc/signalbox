import { describe, expect, it } from "@effect/vitest";

import { createMockMessagesApi, type MockMessagesToolName } from "./mockMessages.ts";

const endpoint = "http://mock.anthropic.invalid/v1/messages";

function post(body: unknown, url = endpoint) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function toolResult(toolUseId: string, content: string, is_error = false) {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error }],
  };
}

function parseSse(text: string) {
  expect(text).toContain("\n\n");
  expect(text).not.toContain("\\n\\n");
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const [eventLine, dataLine, ...extraLines] = frame.split("\n");
      expect(eventLine).toMatch(/^event: [a-z_]+$/);
      expect(dataLine).toMatch(/^data: /);
      expect(extraLines).toEqual([]);
      return {
        event: eventLine!.slice("event: ".length),
        data: JSON.parse(dataLine!.slice("data: ".length)) as { type: string },
      };
    });
}

describe("mock Anthropic Messages API", () => {
  it("serves a text-only boot reply as JSON and estimates count_tokens explicitly", async () => {
    const api = createMockMessagesApi({ bootText: "Claude booted." });
    const message = await api.fetch(post({ model: "claude-test", messages: [], stream: false }));
    expect(message.status).toBe(200);
    expect(message.headers.get("x-signalbox-mock-token-counts")).toBe("estimated");
    expect(await message.json()).toMatchObject({
      type: "message",
      model: "claude-test",
      content: [{ type: "text", text: "Claude booted." }],
      stop_reason: "end_turn",
    });
    expect(api.complete).toBe(true);

    const counted = await api.fetch(
      post(
        { model: "claude-test", messages: [{ role: "user", content: "hello" }] },
        `${endpoint}/count_tokens`,
      ),
    );
    expect(counted.headers.get("x-signalbox-mock-count-tokens")).toBe("estimated");
    expect(await counted.json()).toEqual({ input_tokens: expect.any(Number) });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[0]).toHaveProperty("body");
    expect(api.requests[0]?.bodyBytes).toBeGreaterThan(0);
    expect(api.requests[0]?.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("advances an SSE tool script only after matching results and preserves failures", async () => {
    const api = createMockMessagesApi({
      bootText: "Starting bounded turn.",
      recordRequestBodies: false,
      tools: [
        { name: "Read", input: { file_path: "/work/probe.txt" } },
        {
          name: "Bash",
          input: { command: "echo changed > /work/probe.txt && cat /work/probe.txt" },
        },
      ],
    });
    const first = await api.fetch(post({ messages: [], stream: true }));
    const firstSse = await first.text();
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    const frames = parseSse(firstSse);
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames.map((frame) => frame.data.type)).toEqual(frames.map((frame) => frame.event));
    expect(firstSse).toContain('"name":"Read"');
    expect(firstSse).toContain('"text":"Starting bounded turn."');
    expect(api.complete).toBe(false);

    const missing = await api.fetch(post({ messages: [] }));
    expect(missing.status).toBe(409);
    expect(api.complete).toBe(false);
    expect(api.toolResults).toHaveLength(0);

    const second = await api.fetch(
      post({
        messages: [
          toolResult("toolu_wrong", "ignored"),
          toolResult("toolu_mock_1", "file contents"),
        ],
      }),
    );
    const secondBody = await second.json();
    expect(secondBody).toMatchObject({
      content: [{ type: "tool_use", id: "toolu_mock_2", name: "Bash" }],
      stop_reason: "tool_use",
    });
    expect(api.toolResults).toEqual([
      {
        toolUseId: "toolu_mock_1",
        name: "Read",
        content: "file contents",
        is_error: false,
        raw: {
          type: "tool_result",
          tool_use_id: "toolu_mock_1",
          content: "file contents",
          is_error: false,
        },
      },
    ]);
    expect(api.complete).toBe(false);

    const last = await api.fetch(
      post({ messages: [toolResult("toolu_mock_2", "permission denied", true)] }),
    );
    expect(await last.json()).toMatchObject({
      content: [
        {
          type: "text",
          text: "Mock received 2 scripted tool result(s), including an error result.",
        },
      ],
      stop_reason: "end_turn",
    });
    expect(api.toolResults[1]).toMatchObject({
      toolUseId: "toolu_mock_2",
      name: "Bash",
      content: "permission denied",
      is_error: true,
      raw: { is_error: true },
    });
    expect(api.requests.every((request) => !("body" in request))).toBe(true);
    expect(api.complete).toBe(true);
  });

  it("estimates 50k and 200k token-equivalent contexts without retaining bodies", async () => {
    for (const tokenEquivalent of [50_000, 200_000]) {
      const api = createMockMessagesApi({ recordRequestBodies: false });
      const body = { messages: [{ role: "user", content: "x".repeat(tokenEquivalent * 4) }] };
      const message = await api.fetch(post(body));
      expect(message.status).toBe(200);

      const request = api.requests[0]!;
      expect(request.bodyBytes).toBeGreaterThan(tokenEquivalent * 4);
      expect(request.estimatedInputTokens).toBeGreaterThanOrEqual(tokenEquivalent);
      expect(request.estimatedInputTokens).toBeLessThan(tokenEquivalent + 100);
      expect(request).not.toHaveProperty("body");

      const count = await api.fetch(post(body, `${endpoint}/count_tokens`));
      expect(count.headers.get("x-signalbox-mock-count-tokens")).toBe("estimated");
      expect(await count.json()).toEqual({ input_tokens: request.estimatedInputTokens });
      expect(api.requests[1]).not.toHaveProperty("body");
    }

    const api = createMockMessagesApi({ recordRequestBodies: false });
    const oversized = post({ messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024) }] });
    expect((await api.fetch(oversized)).status).toBe(413);
  });

  it("denies non-Messages hosts and arbitrary paths without forwarding them", async () => {
    const api = createMockMessagesApi();
    const host = await api.fetch(post({ messages: [] }, "https://api.anthropic.com/v1/messages"));
    const path = await api.fetch(post({ messages: [] }, "http://mock.anthropic.invalid/v1/files"));
    const nested = await api.fetch(
      post({ messages: [] }, "http://mock.anthropic.invalid/v1/messages/extra"),
    );

    for (const response of [host, path, nested]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        type: "error",
        error: { type: "not_found_error" },
      });
    }
    expect(api.deniedRequests).toEqual([
      "https://api.anthropic.com/v1/messages",
      "http://mock.anthropic.invalid/v1/files",
      "http://mock.anthropic.invalid/v1/messages/extra",
    ]);
    expect(api.complete).toBe(false);
  });

  it("scripts the bounded Claude tool set in order", async () => {
    const tools: Array<{ name: MockMessagesToolName; input: Record<string, string> }> = [
      { name: "Read", input: { file_path: "/work/probe.txt" } },
      {
        name: "Edit",
        input: { file_path: "/work/probe.txt", old_string: "before", new_string: "after" },
      },
      { name: "Write", input: { file_path: "/work/probe.txt", content: "after" } },
      { name: "Grep", input: { path: "/work", pattern: "after" } },
      { name: "Glob", input: { path: "/work", pattern: "**/*.txt" } },
      { name: "Bash", input: { command: "echo after > /work/probe.txt && cat /work/probe.txt" } },
    ];
    const api = createMockMessagesApi({ tools });
    let previousResult = "";

    for (const [index, expected] of tools.entries()) {
      const response = await api.fetch(
        post({ messages: previousResult ? [toolResult(previousResult, `result ${index}`)] : [] }),
      );
      const message = (await response.json()) as {
        content: Array<{ type: string; id?: string; name?: string }>;
      };
      const call = message.content.find((block) => block.type === "tool_use");
      expect(call).toMatchObject({
        type: "tool_use",
        id: `toolu_mock_${index + 1}`,
        name: expected.name,
      });
      previousResult = call!.id!;
    }

    await api.fetch(post({ messages: [toolResult(previousResult, "done")] }));
    expect(api.toolResults.map((result) => result.name)).toEqual(tools.map((tool) => tool.name));
    expect(api.complete).toBe(true);
  });
});
