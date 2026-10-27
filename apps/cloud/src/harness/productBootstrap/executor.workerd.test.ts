// @effect-diagnostics nodeBuiltinImport:off - this fixture runs the public executor bridge across a real local Workerd DO RPC boundary.
import * as NodeURL from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

let harness: ReturnType<typeof createTestHarness>;
beforeAll(async () => {
  harness = createTestHarness({
    workers: [
      {
        config: {
          name: "1070-product-executor-cancellation",
          main: NodeURL.fileURLToPath(
            new URL("./tests/executor.workerd.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-19",
          compatibility_flags: ["nodejs_compat"],
          durable_objects: { bindings: [{ name: "EXECUTOR", class_name: "ExecutorService" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["ExecutorService"] }],
        },
      },
    ],
  });
  await harness.listen();
}, 60_000);
afterAll(async () => {
  if (harness !== undefined) await harness.close();
});

it("aborts and joins an actual RPC executor forward using the local request signal", async () => {
  const response = await harness.fetch("http://proof/cancel");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(JSON.parse(body)).toEqual({
    roundTrip: {
      status: 202,
      statusText: "Accepted",
      received: "request-header",
      grant: "success-grant",
      body: "echo body",
    },
    result: { aborted: true, message: "local request cancelled" },
    remote: {
      stopped: true,
      requestAborted: true,
      grant: "fresh-legitimate-grant",
      body: "tool call",
    },
  });
});
