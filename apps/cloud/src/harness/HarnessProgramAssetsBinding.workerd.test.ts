// @effect-diagnostics nodeBuiltinImport:off - Wrangler launches local Workerd for the WorkerLoader roundtrip.
import * as NodeURL from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "harness-program-assets-proxy",
        main: NodeURL.fileURLToPath(
          new URL("./tests/HarnessProgramAssetsBinding.workerd.fixture.ts", import.meta.url),
        ),
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
        worker_loaders: [{ binding: "LOADER" }],
        services: [{ binding: "PROGRAM_ASSETS", service: "harness-program-assets-source" }],
        durable_objects: {
          bindings: [{ name: "ASSET_PROXY_TEST", class_name: "ProgramAssetsProbeObject" }],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["ProgramAssetsProbeObject"] }],
      },
    },
    {
      config: {
        name: "harness-program-assets-source",
        main: NodeURL.fileURLToPath(
          new URL("./tests/HarnessProgramAssetsSource.workerd.fixture.ts", import.meta.url),
        ),
        compatibility_date: "2026-10-01",
      },
    },
  ],
});

beforeAll(() => harness.listen(), 60_000);
afterAll(() => harness.close());

it("forwards the product PROGRAM_ASSETS binding through ctx.exports and WorkerLoader", async () => {
  const response = await harness.fetch("https://program-assets-proxy/roundtrip");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(JSON.parse(body)).toEqual({
    status: 206,
    statusText: "Partial Content",
    contentType: "text/plain; charset=utf-8",
    responseHeader: "preserved header",
    body: "POST|preserved header|preserved request body|stream tail",
  });

  const errorResponse = await harness.fetch("https://program-assets-proxy/error");
  const errorBody = await errorResponse.text();
  expect(errorResponse.status, errorBody).toBe(200);
  expect(JSON.parse(errorBody)).toEqual({
    status: 503,
    statusText: "Service Unavailable",
    contentType: "text/plain;charset=UTF-8",
    responseHeader: "error",
    body: "raw program assets fetch failed",
  });

  const thrownResponse = await harness.fetch("https://program-assets-proxy/throw");
  const thrownBody = await thrownResponse.text();
  expect(thrownResponse.status, thrownBody).toBe(200);
  const thrown = JSON.parse(thrownBody);
  expect(thrown).toMatchObject({
    status: 500,
    statusText: "Internal Server Error",
    contentType: "application/json",
    responseHeader: null,
  });
  expect(JSON.parse(thrown.body)).toMatchObject({
    name: "Error",
    message: "raw program assets fetch failed",
  });
});
