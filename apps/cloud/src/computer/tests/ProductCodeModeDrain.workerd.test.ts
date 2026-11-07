// @effect-diagnostics nodeBuiltinImport:off - real workerd consumes a temporary local bundle.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";
import { prepareCodeModeHost } from "../../../infra/codeMode/prepare.ts";

it("aborts a suspended anonymous worker and finishes product drain in real workerd", async () => {
  const { code } = await prepareCodeModeHost();
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "product-cell-drain-"));
  let harness: ReturnType<typeof createTestHarness> | undefined;
  try {
    const bundled = await build({
      entryPoints: [NodePath.join(import.meta.dirname, "ProductCodeModeDrain.workerd.fixture.ts")],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "esnext",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:workers", "node:*"],
      write: false,
      plugins: [
        {
          name: "test-logger",
          setup(build) {
            build.onResolve({ filter: /^evlog$/ }, () => ({ path: "evlog", namespace: "test" }));
            build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
              contents: "export const log = { warn() {} };",
              loader: "js",
            }));
          },
        },
      ],
    });
    const main = NodePath.join(root, "main.mjs");
    await NodeFSP.writeFile(main, bundled.outputFiles[0]!.text);
    harness = createTestHarness({
      workers: [
        {
          config: {
            name: "native-cell-drain",
            main,
            compatibility_date: "2026-10-19",
            compatibility_flags: ["nodejs_compat"],
            worker_loaders: [{ binding: "LOADER" }],
            vars: { CODE: code },
            durable_objects: { bindings: [{ name: "HOST", class_name: "Host" }] },
            migrations: [{ tag: "v1", new_sqlite_classes: ["Host"] }],
          },
        },
      ],
    });
    await harness.listen();
    const response = await harness.fetch("http://proof/drain");
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      active: 0,
      processes: 0,
      exit: { signal: 15 },
      stderr: "",
    });
  } finally {
    await harness?.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
