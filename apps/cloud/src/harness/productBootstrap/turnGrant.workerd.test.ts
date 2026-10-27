// @effect-diagnostics nodeBuiltinImport:off - This regression exercises the product grant port across real Workerd RPC.
import * as NodeURL from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

let harness: ReturnType<typeof createTestHarness>;
beforeAll(async () => {
  harness = createTestHarness({
    workers: [
      {
        config: {
          name: "1070-product-turn-grant-rpc",
          main: NodeURL.fileURLToPath(
            new URL("./tests/turnGrant.workerd.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-19",
          compatibility_flags: ["nodejs_compat"],
          durable_objects: { bindings: [{ name: "TURN_GRANTS", class_name: "TurnGrantService" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["TurnGrantService"] }],
        },
      },
    ],
  });
  await harness.listen();
}, 60_000);
afterAll(async () => {
  if (harness !== undefined) await harness.close();
});

it("issues exact publisher-bound grants and joins remote issuance when the turn retires", async () => {
  const response = await harness.fetch("http://proof/turn-grants");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(JSON.parse(body)).toEqual({
    success: {
      grant: JSON.stringify({
        runId: "success",
        nativeTurnEpoch: 2,
        publisher: { generation: 7, facetNonce: "publisher-a" },
      }),
      endpoint: "https://tools-gateway.test/mcp",
      expiresAtMs: 123456789,
    },
    cancelled: { aborted: true, message: "turn retired" },
    stopped: true,
  });
});
