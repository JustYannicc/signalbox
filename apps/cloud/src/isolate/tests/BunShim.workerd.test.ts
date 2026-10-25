// @effect-diagnostics nodeBuiltinImport:off - Wrangler's test harness needs a filesystem entry point.
import * as NodeURL from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createTestHarness } from "wrangler";

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "bun-shim-proof",
        main: NodeURL.fileURLToPath(new URL("./BunShim.fixture.ts", import.meta.url)),
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        durable_objects: { bindings: [{ name: "PROOF", class_name: "BunShimProof" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["BunShimProof"] }],
      },
    },
  ],
});

beforeAll(() => harness.listen(), 60_000);
afterAll(() => harness.close());

describe("Bun compatibility in a workerd Durable Object", () => {
  it("executes the portable APIs and injected SQLite file/process boundaries", async () => {
    const response = await harness.fetch("http://proof/");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      checks: expect.arrayContaining([
        "wyhash",
        "file-exact-bytes",
        "spawn-host-boundary",
        "unknown-inventory",
        "no-blocking-sleep",
      ]),
    });
    const persisted = await harness.fetch("http://proof/persistence");
    expect(await persisted.json()).toEqual({ previous: "text ✓" });
  });
});
