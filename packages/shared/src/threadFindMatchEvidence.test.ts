import { describe, expect, it } from "vite-plus/test";
import {
  createThreadFindMatchEvidence,
  verifyThreadFindMatchEvidence,
} from "@t3tools/shared/threadFindMatchEvidence";
import { searchableMessageDocument, searchablePlanDocument } from "@t3tools/shared/threadFindText";

describe("Find match evidence", () => {
  const document = { source: "😀 **ΟΣ**\r\nος", segments: [{ text: "😀 ΟΣ" }, { text: "ος" }] };

  it("uses full portable SHA-256 and exact UTF-16 literal/casefold intervals", () => {
    const first = createThreadFindMatchEvidence(document, "οσ", 0)!;
    expect(first).toEqual({
      version: 1,
      documentId: "573a864f3e1a9eba30812505dececa98ca708a13571c085916930b87a2ff7fea",
      segmentIndex: 0,
      start: 3,
      end: 5,
    });
    const second = createThreadFindMatchEvidence(document, "ΟΣ", 1)!;
    expect(verifyThreadFindMatchEvidence(document, "οσ", 1, second)).toEqual({
      segmentIndex: 1,
      start: 0,
      end: 2,
    });
    expect(second.documentId).toBe(first.documentId);
    const turkish = { source: "İ i", segments: [{ text: "İ i" }] };
    expect(createThreadFindMatchEvidence(turkish, "i", 0)).toMatchObject({ start: 2, end: 3 });
  });

  it("rejects changed source, same-length semantic labels and changed segment boundaries", () => {
    const evidence = createThreadFindMatchEvidence(document, "οσ", 0)!;
    expect(
      verifyThreadFindMatchEvidence(
        { ...document, source: document.source.replace("**", "__") },
        "οσ",
        0,
        evidence,
      ),
    ).toBeNull();
    expect(
      verifyThreadFindMatchEvidence(
        { ...document, segments: [{ text: "😎 ΟΣ" }, { text: "ος" }] },
        "οσ",
        0,
        evidence,
      ),
    ).toBeNull();
    const a = { source: "same", segments: [{ text: "ab" }, { text: "cd" }] };
    const b = { source: "same", segments: [{ text: "a" }, { text: "bcd" }] };
    expect(createThreadFindMatchEvidence(a, "a", 0)!.documentId).not.toBe(
      createThreadFindMatchEvidence(b, "a", 0)!.documentId,
    );
    const lone = { source: "\uD800", segments: [{ text: "needle" }] };
    const replacement = { ...lone, source: "\uFFFD" };
    expect(createThreadFindMatchEvidence(lone, "needle", 0)!.documentId).not.toBe(
      createThreadFindMatchEvidence(replacement, "needle", 0)!.documentId,
    );
  });

  it("validates the exact requested occurrence and rejects altered evidence", () => {
    const evidence = createThreadFindMatchEvidence(document, "οσ", 0)!;
    expect(verifyThreadFindMatchEvidence(document, "οσ", 1, evidence)).toBeNull();
    expect(verifyThreadFindMatchEvidence(document, "😀", 0, evidence)).toBeNull();
    expect(verifyThreadFindMatchEvidence(document, "οσ", 0, { ...evidence, start: 4 })).toBeNull();
    expect(verifyThreadFindMatchEvidence(document, "οσ", 0, { ...evidence, end: 4 })).toBeNull();
    expect(
      verifyThreadFindMatchEvidence(document, "οσ", 0, { ...evidence, segmentIndex: 1 }),
    ).toBeNull();
    expect(
      verifyThreadFindMatchEvidence(document, "οσ", 0, { ...evidence, documentId: "0".repeat(64) }),
    ).toBeNull();
    expect(verifyThreadFindMatchEvidence(document, "οσ", 0, undefined)).toBeNull();
    expect(verifyThreadFindMatchEvidence(document, "οσ", 0, null)).toBeNull();
    for (const occurrence of [-1, 0.5, NaN, Infinity, 2]) {
      expect(createThreadFindMatchEvidence(document, "οσ", occurrence)).toBeNull();
    }
    expect(createThreadFindMatchEvidence(document, "", 0)).toBeNull();
    expect(createThreadFindMatchEvidence(document, "missing", 0)).toBeNull();
    const literal = { source: ".* aaaa", segments: [{ text: ".* aaaa" }] };
    expect(createThreadFindMatchEvidence(literal, ".*", 0)).toMatchObject({ start: 0, end: 2 });
    expect(createThreadFindMatchEvidence(literal, "aa", 1)).toMatchObject({ start: 5, end: 7 });
    expect(createThreadFindMatchEvidence(literal, "aa", 2)).toBeNull();
  });

  it("accepts actual original-source message and plan documents", () => {
    const message = {
      role: "assistant" as const,
      text: "😀 [needle](https://a.test)\r\n**needle**",
      streaming: false,
    };
    const parsed = searchableMessageDocument(message)!;
    expect(parsed.source).toBe(message.text);
    const evidence = createThreadFindMatchEvidence(parsed, "NEEDLE", 1)!;
    expect(verifyThreadFindMatchEvidence(parsed, "needle", 1, evidence)).toEqual({
      segmentIndex: evidence.segmentIndex,
      start: evidence.start,
      end: evidence.end,
    });
    const changed = searchableMessageDocument({
      ...message,
      text: message.text.replace("a.test", "b.test"),
    })!;
    expect(changed.segments.map((s) => s.text)).toEqual(parsed.segments.map((s) => s.text));
    expect(verifyThreadFindMatchEvidence(changed, "needle", 1, evidence)).toBeNull();
    const plan = searchablePlanDocument("# Needle plan\n\nShip needle");
    const title = createThreadFindMatchEvidence(plan, "needle", 0)!;
    expect(verifyThreadFindMatchEvidence(plan, "needle", 0, title)).toEqual({
      segmentIndex: 0,
      start: 0,
      end: 6,
    });
  });
});
