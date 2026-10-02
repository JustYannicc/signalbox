import { describe, expect, it } from "vite-plus/test";

import { buildFeedbackEnvelope } from "./feedbackEnvelope";
import { formatLogEntry, LogRingBuffer } from "./feedbackLogs";

/** Splits an envelope the way Relay does: JSON items by newline, attachments by `length`. */
function parseEnvelope(bytes: Uint8Array) {
  const decoder = new TextDecoder();
  let offset = 0;
  const readLine = () => {
    const end = bytes.indexOf(0x0a, offset);
    const line = decoder.decode(bytes.subarray(offset, end === -1 ? bytes.length : end));
    offset = end === -1 ? bytes.length : end + 1;
    return line;
  };
  const header = JSON.parse(readLine());
  const items: Array<{ header: Record<string, unknown>; payload: Uint8Array }> = [];
  while (offset < bytes.length) {
    const itemHeader = JSON.parse(readLine()) as Record<string, unknown>;
    if (typeof itemHeader.length === "number") {
      const payload = bytes.subarray(offset, offset + itemHeader.length);
      offset += itemHeader.length;
      expect(bytes[offset]).toBe(0x0a);
      offset += 1;
      items.push({ header: itemHeader, payload });
    } else {
      items.push({ header: itemHeader, payload: new TextEncoder().encode(readLine()) });
    }
  }
  return { header, items };
}

describe("buildFeedbackEnvelope", () => {
  it("frames binary attachments by byte length, even when they contain newlines", () => {
    const png = new Uint8Array([0x89, 0x50, 0x0a, 0x0a, 0x00, 0xff]);
    const logs = "ünïcödé line\nsecond line";
    const envelope = buildFeedbackEnvelope({
      header: { event_id: "abc" },
      event: { event_id: "abc", contexts: { feedback: { message: "multi\nline" } } },
      attachments: [
        { filename: "screenshot.png", contentType: "image/png", data: png },
        { filename: "logs.txt", contentType: "text/plain", data: new TextEncoder().encode(logs) },
      ],
    });

    const parsed = parseEnvelope(envelope);
    expect(parsed.header).toEqual({ event_id: "abc" });
    expect(parsed.items.map((item) => item.header.type)).toEqual([
      "feedback",
      "attachment",
      "attachment",
    ]);
    expect(JSON.parse(new TextDecoder().decode(parsed.items[0]!.payload))).toMatchObject({
      contexts: { feedback: { message: "multi\nline" } },
    });
    expect(parsed.items[1]!.header).toEqual({
      type: "attachment",
      length: 6,
      filename: "screenshot.png",
      content_type: "image/png",
    });
    expect([...parsed.items[1]!.payload]).toEqual([...png]);
    // Byte length, not string length: the umlauts take two bytes each.
    expect(parsed.items[2]!.header.length).toBe(new TextEncoder().encode(logs).byteLength);
    expect(new TextDecoder().decode(parsed.items[2]!.payload)).toBe(logs);
  });
});

describe("LogRingBuffer", () => {
  it("keeps the newest entries in order once full", () => {
    const buffer = new LogRingBuffer(3);
    for (const entry of ["a", "b", "c", "d", "e"]) buffer.push(entry);
    expect(buffer.snapshot()).toEqual(["c", "d", "e"]);
  });

  it("returns everything before it fills", () => {
    const buffer = new LogRingBuffer(3);
    buffer.push("a");
    buffer.push("b");
    expect(buffer.snapshot()).toEqual(["a", "b"]);
  });
});

describe("formatLogEntry", () => {
  it("stringifies errors, objects and cycles without throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const entry = formatLogEntry(
      "error",
      ["failed", { code: 1 }, cyclic, new Error("boom")],
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(
      entry.startsWith('2026-01-01T00:00:00.000Z [error] failed {"code":1} [object Object]'),
    ).toBe(true);
    expect(entry).toContain("boom");
  });

  it("truncates huge entries", () => {
    const entry = formatLogEntry("warn", ["x".repeat(10_000)], new Date(0));
    expect(entry.length).toBeLessThan(2_100);
    expect(entry.endsWith("(truncated)")).toBe(true);
  });
});
