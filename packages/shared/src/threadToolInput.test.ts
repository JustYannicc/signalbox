import { describe, expect, it } from "vite-plus/test";
import { threadToolInput } from "@t3tools/shared/threadToolInput";

// Keep the previous indexer's extraction here as an independent compatibility oracle.
function legacyInput(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return String(value);
  if (typeof value !== "object" || value === null || depth >= 3) return "";
  if (Array.isArray(value))
    return value
      .map((part) => legacyInput(part, depth + 1))
      .filter(Boolean)
      .join(" ");
  return Object.entries(value)
    .filter(
      ([key]) =>
        !/secret|token|password|credential|authorization|cookie|base64|image|binary/i.test(key),
    )
    .map(([, item]) => legacyInput(item, depth + 1))
    .filter(Boolean)
    .join("\n");
}

const corpus = [
  undefined,
  null,
  "",
  "  \n ",
  "café",
  false,
  true,
  0,
  -0,
  1.5,
  NaN,
  Infinity,
  {},
  [],
  [null, "", 0, false, " café "],
  [
    { type: "text", text: "café" },
    { type: "text", text: "second" },
  ],
  { café: "café", password: "café", Authorization: "café", q: "allowed" },
  { q: ["first", "", null, ["nested", { omitted: "depth three object" }]], next: false },
  { one: { two: { three: "included", hidden: { four: "omitted" } } } },
  { one: ' café\n"😀\\ ', nested: { token: "hidden", two: [false, 123, "last"] } },
  { a: "x".repeat(998), b: "😀 café" },
  { a: "x".repeat(990), b: "café café café", c: "after the shared limit" },
  "x".repeat(999) + "😀café",
  "x".repeat(998) + "😀café",
];

describe("tool input search provenance", () => {
  it.each(corpus.map((input, index) => ({ input, index })))(
    "preserves the previous index text for corpus case $index",
    ({ input }) => {
      const original = legacyInput(input);
      const end =
        original.length > 1000 && /[\uD800-\uDBFF]/u.test(original[999] ?? "") ? 999 : 1000;
      expect(threadToolInput(input).text).toBe(original.slice(0, end));
    },
  );

  it("records only surviving leaf paths at their exact canonical offsets", () => {
    const input = threadToolInput({
      café: "café",
      password: "café",
      nested: { q: ["café", { hidden: "café" }], cookie: "café", count: 0 },
      last: false,
    });
    expect(input).toEqual({
      text: "café\ncafé\n0\nfalse",
      leaves: [
        { path: ["café"], start: 0, text: "café" },
        { path: ["nested", "q", 0], start: 5, text: "café" },
        { path: ["nested", "count"], start: 10, text: "0" },
        { path: ["last"], start: 12, text: "false" },
      ],
    });
  });

  it("clips leaf provenance once across fields and never splits a surrogate pair", () => {
    expect(threadToolInput({ a: "x".repeat(990), b: "café café café" }).leaves.at(-1)).toEqual({
      path: ["b"],
      start: 991,
      text: "café café",
    });
    const clipped = threadToolInput({ a: "x".repeat(998), b: "😀 café" });
    expect(clipped.text).toBe("x".repeat(998) + "\n");
    expect(clipped.leaves).toHaveLength(1);
  });
});
