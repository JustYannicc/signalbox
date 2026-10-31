import { preparedReleaseAsset } from "../../../../src/harness/HarnessProcessFacetEnvironment.ts";
import { qualifierCodexFacetInputs } from "../facetEnvironmentContract.ts";
import type { Configuration } from "./configuration.ts";
import { assert, PROCESS_ID } from "./common.ts";

export function codexFacet(
  config: Pick<Configuration, "expectedRelease" | "runId" | "workerName">,
) {
  const engine = Object.entries(config.expectedRelease.plan.preparedModules).find(
    ([, value]) => value.type === "wasm" && value.path.endsWith("codex/engine.wasm"),
  );
  assert(engine, "The frozen official engine is absent from the selected prepared release");
  return {
    processId: PROCESS_ID,
    codeId: config.expectedRelease.artifact.releaseId,
    residentBytes: 104 * 1024 * 1024,
    mainModule: "qualifier-facet.mjs",
    entrypoint: "CodexFacet",
    modules: {
      "qualifier-facet.mjs": {
        js: "export { CodexFacet } from './qualifier-implementation.mjs';\n",
      },
      "codex-engine.wasm": preparedReleaseAsset(config.expectedRelease, engine[0]),
    },
    facetEnv: qualifierCodexFacetInputs(config),
  } as const;
}
