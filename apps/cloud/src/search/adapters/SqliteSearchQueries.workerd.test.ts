// @effect-diagnostics nodeBuiltinImport:off - Wrangler needs a filesystem entry point.
import * as NodeURL from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createTestHarness } from "wrangler";

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "search-queries-test",
        main: NodeURL.fileURLToPath(new URL("./SqliteSearchQueries.fixture.ts", import.meta.url)),
        compatibility_date: "2026-10-01",
        durable_objects: { bindings: [{ name: "INDEX", class_name: "QueryIndex" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["QueryIndex"] }],
      },
    },
  ],
});

beforeAll(() => harness.listen(), 60_000);
afterAll(() => harness.close());

describe("keyword search in workerd", () => {
  it.each([
    { name: "terms across parts", query: "alpha beta gamma", expected: ["legacy", "split"] },
    { name: "legacy rows", query: "legacy alpha beta", expected: ["legacy"] },
    { name: "no full match", query: "alpha beta missing", expected: [] },
    {
      name: "a maximum-length keyword query",
      query: Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(" "),
      expected: ["maximum"],
    },
  ])("matches $name within Workers SQL limits", async ({ query, expected }) => {
    const response = await harness.fetch(`/?q=${encodeURIComponent(query)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      candidates: expected.map((itemId) => ({ itemId })),
      hasMore: false,
    });
  });
});
