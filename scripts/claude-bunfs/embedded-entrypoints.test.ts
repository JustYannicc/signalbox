import { describe, expect, it } from "@effect/vitest";
import { discoverEmbeddedModuleReferences } from "./embedded-entrypoints.ts";

describe("embedded executable paths", () => {
  it("preserves path-addressed modules which static imports do not reach", () => {
    const worker = "/$bunfs/root/hooks/worker.js";
    const imported = "/$bunfs/root/dep.js";
    const references = discoverEmbeddedModuleReferences(
      [
        {
          name: "/$bunfs/root/cli",
          source: `import '${imported}';const workerURL=()=>({HOOKS_WORKER_URL:'${worker}'}).HOOKS_WORKER_URL;new Worker(workerURL()); // '${imported}'`,
        },
        {
          name: worker,
          source: `export const self='${worker}';require('${imported}');import.meta.require('${imported}');`,
        },
      ],
      new Set([worker, imported]),
    );
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ importer: "/$bunfs/root/cli", target: worker });
  });
});
