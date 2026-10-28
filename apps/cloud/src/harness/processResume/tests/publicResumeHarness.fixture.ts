// @effect-diagnostics nodeBuiltinImport:off - this shared harness runs the public C suite in local Workerd.
import * as NodeURL from "node:url";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";

export async function createPublicResumeHarness(
  options: {
    readonly name?: string;
    readonly main?: string;
    readonly supervisorClass?: string;
  } = {},
) {
  const supervisorClass = options.supervisorClass ?? "ProofSupervisor";
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
  const harness = createTestHarness({
    workers: [
      {
        config: {
          name: options.name ?? "1396-public-resume-proof",
          main:
            options.main ??
            NodeURL.fileURLToPath(new URL("./publicResume.workerd.fixture.ts", import.meta.url)),
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
              { name: "HARNESS_THREAD_SUPERVISOR", class_name: supervisorClass },
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
                supervisorClass,
              ],
            },
          ],
        },
      },
    ],
  });
  return harness;
}
