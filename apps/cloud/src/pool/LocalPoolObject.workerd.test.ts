// @effect-diagnostics nodeBuiltinImport:off - Wrangler needs a filesystem entry point.
import * as NodeURL from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "local-pool-rpc-test",
        main: NodeURL.fileURLToPath(
          new URL("./tests/localPoolWorkerd.fixture.ts", import.meta.url),
        ),
        compatibility_date: "2026-10-01",
        durable_objects: { bindings: [{ name: "POOLS", class_name: "LocalPool" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["LocalPool"] }],
      },
    },
  ],
});

beforeAll(() => harness.listen(), 60_000);
afterAll(() => harness.close());

it("retains the registered transport after configuration returns and forwards only an owner's exact request", async () => {
  const response = await harness.fetch("http://proof/");
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(JSON.parse(text)).toEqual({
    denied: "denied",
    forwarded: "forwarded",
    status: 201,
    response: "pool answer",
    sent: [
      {
        body: '{"model":"claude-opus-5-5", "messages": [{"role":"user","content":"keep exact bytes"}]}',
        header: "kept",
      },
    ],
  });
});
