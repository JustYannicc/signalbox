import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { describe, expect, it } from "@effect/vitest";

import { makeUsageScanner } from "./usageScanner.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** Feeds `body` in pieces cut at `cuts` (byte offsets), then reads the result. */
const scan = (
  provider: ModelGatewayProvider,
  contentType: string | null,
  body: string,
  cuts: ReadonlyArray<number> = [],
) => {
  const scanner = makeUsageScanner(provider, contentType);
  const encoded = bytes(body);
  let from = 0;
  for (const cut of [...cuts, encoded.byteLength]) {
    scanner.push(encoded.slice(from, cut));
    from = cut;
  }
  return scanner.finish();
};

const ANTHROPIC_STREAM = [
  "event: message_start",
  'data: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":1}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"the \\"usage\\" is ünïcödé"}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":55}}',
  "",
].join("\r\n");

describe("makeUsageScanner", () => {
  it("reads an Anthropic stream, the last reported counts winning", () => {
    expect(scan("anthropic", "text/event-stream", ANTHROPIC_STREAM)).toEqual({
      model: "claude-opus-5-5",
      usage: { input: 10, output: 55, cacheRead: 30, cacheWrite: 20 },
    });
  });

  it("reads the same however the chunks split lines and characters", () => {
    const length = bytes(ANTHROPIC_STREAM).byteLength;
    const whole = scan("anthropic", "text/event-stream", ANTHROPIC_STREAM);
    for (let cut = 1; cut < length; cut++) {
      expect(scan("anthropic", "text/event-stream", ANTHROPIC_STREAM, [cut])).toEqual(whole);
    }
    const everyByte = Array.from({ length: length - 1 }, (_, index) => index + 1);
    expect(scan("anthropic", "text/event-stream", ANTHROPIC_STREAM, everyByte)).toEqual(whole);
  });

  it("keeps what a stream reported before it was cut off", () => {
    const cut = ANTHROPIC_STREAM.indexOf("event: message_delta");
    expect(scan("anthropic", "text/event-stream", ANTHROPIC_STREAM.slice(0, cut))).toEqual({
      model: "claude-opus-5-5",
      usage: { input: 10, output: 1, cacheRead: 30, cacheWrite: 20 },
    });
  });

  it("reads OpenAI's completed response, counting cached input apart", () => {
    const body = [
      'data: {"type":"response.created","response":{"model":"gpt-6","usage":null}}',
      "",
      'data: {"type":"response.completed","response":{"model":"gpt-6-2026-09-01","usage":{"input_tokens":900,"input_tokens_details":{"cached_tokens":600},"output_tokens":70}}}',
      "",
    ].join("\n");
    expect(scan("openai", "text/event-stream", body, [40, 41, 120])).toEqual({
      model: "gpt-6-2026-09-01",
      usage: { input: 300, output: 70, cacheRead: 600, cacheWrite: 0 },
    });
  });

  it("reads a whole JSON body for either provider", () => {
    expect(
      scan(
        "anthropic",
        "application/json",
        '{"model":"claude-haiku-5","usage":{"input_tokens":5,"output_tokens":6}}',
        [7],
      ),
    ).toEqual({
      model: "claude-haiku-5",
      usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 },
    });
    expect(
      scan(
        "openai",
        "application/json; charset=utf-8",
        '{"model":"gpt-6","usage":{"input_tokens":5,"input_tokens_details":{"cached_tokens":2},"output_tokens":6}}',
      ),
    ).toEqual({ model: "gpt-6", usage: { input: 3, output: 6, cacheRead: 2, cacheWrite: 0 } });
  });

  it("leaves usage null for malformed, oversized, or unknown bodies", () => {
    const none = { model: null, usage: null };
    expect(
      scan("anthropic", "text/event-stream", 'data: {"type":"message_start","usage":\n\n'),
    ).toEqual(none);
    expect(
      scan(
        "anthropic",
        "text/event-stream",
        'data: {"type":"message_delta","usage":{"output_tokens":-4}}\n\n',
      ),
    ).toEqual(none);
    expect(scan("openai", "application/json", '{"model":"gpt-6","usage":')).toEqual(none);
    expect(scan("openai", "application/json", '{"error":{"message":"nope"}}')).toEqual(none);
    const huge = `{"padding":"${"x".repeat(2 << 20)}","usage":{"input_tokens":1}}`;
    expect(scan("anthropic", "application/json", huge, [1 << 19, 1 << 20])).toEqual(none);
    expect(scan("anthropic", "text/plain", '{"usage":{"input_tokens":1}}')).toEqual(none);
    expect(scan("anthropic", null, '{"usage":{"input_tokens":1}}')).toEqual(none);
  });
});
