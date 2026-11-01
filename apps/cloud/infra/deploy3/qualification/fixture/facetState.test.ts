import { expect, it } from "vite-plus/test";
import { facetState, flushFacetDiagnostics } from "./facetState.ts";
import type { QualifierCapabilities } from "./capabilities.ts";

type Raw = Parameters<QualifierCapabilities["recordRaw"]>[0];
function captureFixture(write: (raw: Raw) => Promise<void>) {
  const records: { kind: string; value: unknown }[] = [];
  const capability = {
    recordRaw: write,
    append: async (kind: string, value: unknown) => {
      records.push({ kind, value });
    },
  } as unknown as QualifierCapabilities;
  const ctx = { storage: { sql: {} }, waitUntil() {} } as unknown as DurableObjectState;
  return { state: facetState(ctx, capability, "capture-incarnation"), ctx, records };
}

it("the real facet state retains full stdout and shutdown stderr beyond 16 KiB", async () => {
  const chunks: Raw[] = [];
  const fixture = captureFixture(async (raw) => {
    chunks.push(raw);
  });
  const stdout = new TextEncoder().encode(`${"out".repeat(20_000)}stdout-tail`);
  const stderr = new TextEncoder().encode(`${"err".repeat(17_000)}stderr-tail`);
  fixture.state.raw("native-stdout", stdout);
  await fixture.state.flush("request-settled");
  fixture.state.raw("native-stderr", stderr);
  await flushFacetDiagnostics(fixture.ctx, "disposed");
  for (const [channel, bytes] of [
    ["native-stdout", stdout],
    ["native-stderr", stderr],
  ] as const) {
    const stream = chunks.filter((chunk) => chunk.channel === channel);
    const actual = new Uint8Array(stream.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0));
    let offset = 0;
    for (const chunk of stream) {
      actual.set(chunk.bytes, offset);
      offset += chunk.bytes.byteLength;
    }
    expect(actual).toEqual(bytes);
  }
  expect(fixture.records.at(-1)?.value).toMatchObject({
    reason: "disposed",
    streams: {
      "native-stdout": { observedBytes: stdout.byteLength, complete: true },
      "native-stderr": { observedBytes: stderr.byteLength, complete: true },
    },
  });
});

it("a saturated capture queue fails loudly and preserves its incomplete byte counts", async () => {
  const released = Promise.withResolvers<void>();
  const fixture = captureFixture(async () => released.promise);
  fixture.state.raw("native-stdout", new Uint8Array(1024 * 1024 + 1));
  released.resolve();
  await expect(fixture.state.flush()).rejects.toThrow("Native byte capture failed");
  expect(fixture.records.at(-1)?.value).toMatchObject({
    streams: {
      "native-stdout": {
        observedBytes: 1024 * 1024 + 1,
        acceptedBytes: 1024 * 1024,
        complete: false,
        incompleteReason: "capture-sink-rejected",
      },
    },
  });
});
