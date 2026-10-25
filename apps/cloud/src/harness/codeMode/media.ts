import type { CodeModeContent } from "./types.ts";

const imageExpected =
  "image expects a non-empty image URL string, an object with image_url and optional detail, or a raw MCP image block";
const audioExpected =
  "audio expects a non-empty audio URL string, an object with audio_url, or a raw MCP audio block";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mcpUrl(value: Record<string, unknown>, kind: "image" | "audio") {
  if (typeof value.type !== "string") throw kind === "image" ? imageExpected : audioExpected;
  if (value.type !== kind)
    throw `${kind} only accepts MCP ${kind} blocks, got ${JSON.stringify(value.type)}`;
  if (typeof value.data !== "string" || value.data.length === 0)
    throw `${kind} expected MCP ${kind} data`;
  if (/^data:/i.test(value.data)) return value.data;
  const mime = value.mimeType ?? value.mime_type;
  return `data:${typeof mime === "string" && mime.length > 0 ? mime : "application/octet-stream"};base64,${value.data}`;
}

export function codeModeImage(value: unknown, detailOverride?: unknown): CodeModeContent {
  let url: string;
  let detail: unknown;
  const item = object(value);
  if (typeof value === "string") url = value;
  else if (item !== undefined) {
    if (item.image_url !== undefined) {
      if (typeof item.image_url !== "string") throw imageExpected;
      url = item.image_url;
      detail = item.detail;
    } else {
      url = mcpUrl(item, "image");
      const meta = object(item._meta)?.["codex/imageDetail"];
      if (["auto", "low", "high", "original"].includes(String(meta))) detail = meta;
    }
  } else throw imageExpected;
  if (url.length === 0) throw imageExpected;
  if (/^https?:/i.test(url))
    throw "Tool call failed: remote image URLs are not supported in tool outputs. Pass a base64 data URI instead";
  if (!/^data:/i.test(url))
    throw "Tool call failed: invalid image output. Pass a base64 data URI instead";
  if (detail != null && typeof detail !== "string")
    throw "image detail must be a string when provided";
  if (detailOverride != null && typeof detailOverride !== "string")
    throw "image detail must be a string when provided";
  const normalized = String(detailOverride ?? detail ?? "high").toLowerCase();
  if (!["auto", "low", "high", "original"].includes(normalized))
    throw "image detail must be one of: auto, low, high, original";
  return { type: "input_image", image_url: url, detail: normalized };
}

export function codeModeAudio(
  value: unknown,
  decodeBase64: (text: string) => string,
): CodeModeContent {
  const item = object(value);
  let url: string;
  if (typeof value === "string") url = value;
  else if (item !== undefined) {
    if (item.audio_url !== undefined) {
      if (typeof item.audio_url !== "string") throw audioExpected;
      url = item.audio_url;
    } else url = mcpUrl(item, "audio");
  } else throw audioExpected;
  if (url.length === 0) throw audioExpected;
  if (!/^data:/i.test(url))
    throw "Tool call failed: invalid audio output. Pass a base64 data URI instead";
  const duration = wavDuration(url, decodeBase64);
  if (duration !== undefined && duration < 0.025)
    return {
      type: "input_text",
      text: "Audio output omitted because the clip is shorter than 25 ms; use a longer clip.",
    };
  return { type: "input_audio", audio_url: url };
}

function wavDuration(url: string, decodeBase64: (text: string) => string): number | undefined {
  const comma = url.indexOf(",");
  if (
    comma === -1 ||
    !url
      .slice(0, comma)
      .split(";")
      .slice(1)
      .some((part) => part.toLowerCase() === "base64")
  )
    return;
  if (url.length - comma - 1 > Math.ceil((50 * 1024 * 1024) / 3) * 4) return;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(decodeBase64(url.slice(comma + 1)), (value) => value.charCodeAt(0));
  } catch {
    return;
  }
  const view = new DataView(bytes.buffer);
  const label = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || label(0) !== "RIFF" || label(8) !== "WAVE") return;
  let format: { sampleRate: number; blockAlign: number } | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const available = Math.min(size, bytes.length - start);
    if (label(offset) === "fmt ") {
      if (available < 16) return;
      let encoding = view.getUint16(start, true);
      if (encoding === 0xfffe) {
        const guid = [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
        if (available < 40 || guid.some((value, index) => bytes[start + 26 + index] !== value))
          return;
        encoding = view.getUint16(start + 24, true);
      }
      if (encoding !== 1 && encoding !== 3) return;
      const sampleRate = view.getUint32(start + 4, true);
      const blockAlign = view.getUint16(start + 12, true);
      if (sampleRate === 0 || blockAlign === 0) return;
      format = { sampleRate, blockAlign };
    }
    if (label(offset) === "data")
      return format === undefined
        ? undefined
        : Math.floor(available / format.blockAlign) / format.sampleRate;
    offset = start + size + (size % 2);
  }
}

export function generatedCodeModeImage(value: unknown): CodeModeContent[] {
  const item = object(value);
  if (item === undefined) throw "generatedImage expects an image generation result object";
  if (item.output_hint !== undefined && typeof item.output_hint !== "string")
    throw "generatedImage output_hint must be a string when provided";
  const image = codeModeImage(value);
  return item.output_hint === undefined
    ? [image]
    : [image, { type: "input_text", text: item.output_hint }];
}
