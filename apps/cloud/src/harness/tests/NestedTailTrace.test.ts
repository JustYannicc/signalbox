import { describe, expect, it } from "vite-plus/test";
import { tailDigest } from "./LocalTailCapture.fixture.ts";
import { decodeNestedTailRecords } from "./NestedTailTrace.fixture.ts";

const event = { schema: "sb1070/producer/v1", identity: "facet:B", milestone: "terminal" };
const raw = JSON.stringify({
  outcome: "ok",
  logs: [{ message: [JSON.stringify({ producerEvent: event })] }],
});
async function wrapper() {
  return { raw, bytes: new TextEncoder().encode(raw).length, sha256: await tailDigest(raw) };
}
const outer = (value: unknown) => ({
  key: "raw/0000000001",
  raw: JSON.stringify([{ logs: [{ message: [JSON.stringify({ qualifierRawTrace: value })] }] }]),
});

describe("nested qualifier Tail bytes", () => {
  it("preserves the enclosing raw bytes and exposes the validated original TraceItem", async () => {
    const record = outer(await wrapper());
    const [decoded] = await decodeNestedTailRecords([record]);
    expect(decoded?.raw).toBe(record.raw);
    expect(decoded?.decodedItems).toEqual([JSON.parse(raw)]);
    expect(decoded?.nestedEvidence).toEqual([
      { outerKey: record.key, bytes: raw.length, sha256: await tailDigest(raw) },
    ]);
  });
  it.each(["bytes", "sha256", "raw"])("rejects an altered %s proof", async (field) => {
    const valid = await wrapper();
    const altered = {
      ...valid,
      [field]: field === "bytes" ? valid.bytes + 1 : field === "raw" ? raw + " " : "0".repeat(64),
    };
    await expect(decodeNestedTailRecords([outer(altered)])).rejects.toThrow("byte proof");
  });
  it("rejects correctly hashed malformed TraceItems", async () => {
    const malformed = JSON.stringify({ logs: [{ message: [2] }] });
    await expect(
      decodeNestedTailRecords([
        outer({ raw: malformed, bytes: malformed.length, sha256: await tailDigest(malformed) }),
      ]),
    ).rejects.toThrow("shape");
  });
});
