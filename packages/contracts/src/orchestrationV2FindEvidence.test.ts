import { describe, expect, it } from "@effect/vitest";
import { OrchestrationV2SearchThreadResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(OrchestrationV2SearchThreadResult);
const encode = Schema.encodeSync(OrchestrationV2SearchThreadResult);

describe("optional Find evidence contract", () => {
  const legacy = {
    snapshotSequence: 27,
    totalMatches: 1,
    activeIndex: 0,
    match: { entryId: "message", runId: null, occurrence: 0 },
  };
  const evidence = { version: 1, documentId: "ab".repeat(32), segmentIndex: 2, start: 3, end: 8 };

  it("preserves legacy results and roundtrips additive v1 evidence", () => {
    expect(decode(legacy)).toEqual(legacy);
    const result = { ...legacy, match: { ...legacy.match, evidence } };
    const decoded = decode(result);
    expect(decoded).toEqual(result);
    expect(encode(decoded)).toEqual(result);
    expect(decode({ ...legacy, match: null }).match).toBeNull();
  });

  it("rejects unsupported versions, weak document ids and invalid offsets", () => {
    for (const invalid of [
      { ...evidence, version: 2 },
      { ...evidence, documentId: "length:12" },
      { ...evidence, documentId: "ab".repeat(31) },
      { ...evidence, segmentIndex: -1 },
      { ...evidence, start: 1.5 },
      { ...evidence, end: -1 },
    ]) {
      expect(() => decode({ ...legacy, match: { ...legacy.match, evidence: invalid } })).toThrow();
    }
  });
});
