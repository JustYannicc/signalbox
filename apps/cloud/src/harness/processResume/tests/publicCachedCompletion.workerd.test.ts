// @effect-diagnostics nodeBuiltinImport:off - this test runs the public C root in isolated local workerd.
import * as NodeURL from "node:url";
import { build } from "esbuild";
import * as NodeProcess from "node:process";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

let harness: ReturnType<typeof createTestHarness>;
beforeAll(async () => {
  const compile = async (variant: string) => {
    const result = await build({
      entryPoints: [
        NodeURL.fileURLToPath(new URL("./plainFacet.workerd.fixture.ts", import.meta.url)),
      ],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "esnext",
      external: ["cloudflare:workers", "node:*", "./transport.wasm"],
      banner: { js: 'import C_TRANSPORT_WASM from "./transport.wasm";' },
      define: { PLAIN_VARIANT: JSON.stringify(variant) },
      write: false,
    });
    const source = result.outputFiles[0]?.text;
    if (source === undefined) throw new Error("The plain fixture bundle is empty.");
    return source;
  };
  const old = await compile("old");
  const next = await compile("next");
  const third = await compile("third");
  harness = createTestHarness({
    workers: [
      {
        config: {
          name: "public-c-cached-completion",
          main: NodeURL.fileURLToPath(
            new URL("./publicCachedCompletion.workerd.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-19",
          compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
          worker_loaders: [{ binding: "LOADER" }],
          vars: {
            RESIDENT_BYTE_LIMIT: "128000000",
            OLD_SOURCE: old,
            NEW_SOURCE: next,
            THIRD_SOURCE: third,
          },
          durable_objects: {
            bindings: [
              { name: "PROCESS_EXECUTION_SHARDS", class_name: "ProofShard" },
              { name: "PLACEMENT_STORES", class_name: "ProofPlacementStore" },
              { name: "HARNESS_FILES_STORE", class_name: "ProofFilesStore" },
              { name: "HARNESS_RUN_STORE", class_name: "ProofRunStore" },
              { name: "HARNESS_THREAD_SUPERVISOR", class_name: "ReceiptCountingSupervisor" },
            ],
          },
          migrations: [
            {
              tag: "v1",
              new_sqlite_classes: [
                "ProofShard",
                "ProofPlacementStore",
                "ProofFilesStore",
                "ProofRunStore",
                "ReceiptCountingSupervisor",
              ],
            },
          ],
        },
      },
    ],
  });
  await harness.listen();
}, 60_000);

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
    NodeProcess.stdout.write("[public-C-harness-close-returned] cachedCompletion\n");
  }
});

it("returns an exact committed checkpoint receipt after C reconstruction without recommitting", async () => {
  const response = await harness.fetch("http://proof/cached-completion");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.reconstructedNonce).not.toBe(result.originalNonce);
  expect(result.recoveredReceipt).toEqual(result.originalReceipt);
  expect(result.beforeCount).toBe(1);
  expect(result.afterCount).toBe(result.beforeCount);
  expect(result.changedDenied).toBe(true);
  expect(result.afterCheckpoint).toEqual(result.beforeCheckpoint);
});
