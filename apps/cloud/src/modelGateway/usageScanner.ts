import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";

import type { ModelUsage } from "./modelGatewayRecord.ts";

/**
 * Reads the model and token usage out of a provider response as its chunks
 * pass through the gateway, without holding the stream. `push` each chunk
 * after it is forwarded, then `finish` once the body ends however it ended.
 *
 * Server-sent events are split into lines, and only `data:` lines that can
 * carry the model or usage are parsed. A JSON body is kept up to
 * `MAX_JSON_BYTES` and parsed at the end. Anything unreadable leaves the
 * result null; it never touches the stream.
 */

export interface UsageScan {
  readonly model: string | null;
  readonly usage: ModelUsage | null;
}

export interface UsageScanner {
  readonly push: (chunk: Uint8Array) => void;
  readonly finish: () => UsageScan;
}

const MAX_JSON_BYTES = 1 << 20;
/** OpenAI's `response.completed` repeats the whole response on one line, so lines get long. */
const MAX_SSE_LINE = 8 << 20;

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const parse = (text: string): Json | null => {
  try {
    return object(JSON.parse(text));
  } catch {
    return null;
  }
};

/** Usage fields seen so far. Anthropic reports them across events; later values win. */
interface Tally {
  model: string | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

const emptyTally = (): Tally => ({
  model: null,
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
});

const takeModel = (tally: Tally, value: unknown) => {
  if (typeof value === "string" && value !== "") tally.model = value;
};

function takeAnthropicUsage(tally: Tally, value: unknown) {
  const usage = object(value);
  if (usage === null) return;
  tally.input = count(usage.input_tokens) ?? tally.input;
  tally.output = count(usage.output_tokens) ?? tally.output;
  tally.cacheRead = count(usage.cache_read_input_tokens) ?? tally.cacheRead;
  tally.cacheWrite = count(usage.cache_creation_input_tokens) ?? tally.cacheWrite;
}

/** OpenAI counts cached tokens inside `input_tokens`; ours are uncached. */
function takeOpenAiUsage(tally: Tally, value: unknown) {
  const usage = object(value);
  if (usage === null) return;
  const input = count(usage.input_tokens);
  const cached = count(object(usage.input_tokens_details)?.cached_tokens) ?? 0;
  if (input !== null) {
    tally.input = Math.max(0, input - cached);
    tally.cacheRead = Math.min(cached, input);
  }
  tally.output = count(usage.output_tokens) ?? tally.output;
  tally.cacheWrite = 0;
}

/** One parsed body (JSON) or event (SSE `data:`). */
function takeMessage(provider: ModelGatewayProvider, tally: Tally, message: Json, sse: boolean) {
  if (provider === "anthropic") {
    if (!sse) {
      takeModel(tally, message.model);
      takeAnthropicUsage(tally, message.usage);
    } else if (message.type === "message_start") {
      const started = object(message.message);
      takeModel(tally, started?.model);
      takeAnthropicUsage(tally, started?.usage);
    } else if (message.type === "message_delta") {
      takeAnthropicUsage(tally, message.usage);
    }
    return;
  }
  const response = sse
    ? message.type === "response.completed" ||
      message.type === "response.incomplete" ||
      message.type === "response.failed"
      ? object(message.response)
      : null
    : message;
  if (response === null) return;
  takeModel(tally, response.model);
  takeOpenAiUsage(tally, response.usage);
}

const result = (tally: Tally): UsageScan => ({
  model: tally.model,
  usage:
    tally.input === null && tally.output === null && tally.cacheRead === null
      ? null
      : {
          input: tally.input ?? 0,
          output: tally.output ?? 0,
          cacheRead: tally.cacheRead ?? 0,
          cacheWrite: tally.cacheWrite ?? 0,
        },
});

const IDLE_SCANNER: UsageScanner = {
  push: () => undefined,
  finish: () => ({ model: null, usage: null }),
};

/** A scanner for one response, chosen by its `content-type`; one that reads nothing for other bodies. */
export function makeUsageScanner(
  provider: ModelGatewayProvider,
  contentType: string | null,
): UsageScanner {
  const type = contentType?.toLowerCase() ?? "";
  if (type.includes("text/event-stream")) return sseScanner(provider);
  if (type.includes("json")) return jsonScanner(provider);
  return IDLE_SCANNER;
}

function sseScanner(provider: ModelGatewayProvider): UsageScanner {
  const decoder = new TextDecoder();
  const tally = emptyTally();
  // The current line's pieces so far, joined once it ends, so a long line is not re-copied per chunk.
  let pieces: Array<string> = [];
  let pending = 0;
  // A line past `MAX_SSE_LINE` is dropped up to its end rather than held.
  let skipping = false;

  const line = (raw: string) => {
    if (!raw.startsWith("data:")) return;
    if (!raw.includes('"usage"') && !raw.includes('"model"')) return;
    const message = parse(raw.slice(5));
    if (message !== null) takeMessage(provider, tally, message, true);
  };
  const take = (text: string) => {
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      const piece = text.slice(start, end);
      start = end + 1;
      const raw = pieces.length === 0 ? piece : pieces.join("") + piece;
      pieces = [];
      pending = 0;
      if (skipping) skipping = false;
      else line(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    }
    const rest = text.slice(start);
    if (skipping || rest === "") return;
    pending += rest.length;
    if (pending > MAX_SSE_LINE) {
      pieces = [];
      pending = 0;
      skipping = true;
    } else {
      pieces.push(rest);
    }
  };

  return {
    push: (chunk) => take(decoder.decode(chunk, { stream: true })),
    finish: () => {
      take(`${decoder.decode()}\n`);
      return result(tally);
    },
  };
}

function jsonScanner(provider: ModelGatewayProvider): UsageScanner {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let overflowed = false;

  return {
    push: (chunk) => {
      if (overflowed) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_JSON_BYTES) {
        overflowed = true;
        text = "";
        return;
      }
      text += decoder.decode(chunk, { stream: true });
    },
    finish: () => {
      const tally = emptyTally();
      const message = overflowed ? null : parse(text + decoder.decode());
      if (message !== null) takeMessage(provider, tally, message, false);
      return result(tally);
    },
  };
}
