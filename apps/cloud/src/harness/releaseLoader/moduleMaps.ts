import * as Schema from "effect/Schema";
import type { ClaudeReleasePlan } from "../HarnessReleasePlan.ts";

const decodeModuleMap = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ path: Schema.String, type: Schema.String })),
  ),
  { onExcessProperty: "error" },
);

export function validateModuleMaps(
  plan: ClaudeReleasePlan,
  payloads: ReadonlyMap<string, Uint8Array>,
) {
  for (const map of plan.moduleMaps) {
    const bytes = payloads.get(map.path);
    if (bytes === undefined || map.component === "codex")
      throw new Error(`Missing Claude module map payload: ${map.path}`);
    const entries = decodeModuleMap(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const modules = Object.values(plan.preparedModules).filter(
      (module) => module.component === map.component,
    );
    if (Object.keys(entries).length !== modules.length)
      throw new Error(`Module map entry set disagrees with prepared modules: ${map.path}`);
    const manifestPath = plan.componentManifestPaths[map.component];
    const prefix = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1);
    for (const module of modules) {
      const entry = Object.hasOwn(entries, module.name) ? entries[module.name] : undefined;
      // Compare literal paths; percent-escaped native names must never be URL-decoded.
      if (entry === undefined || prefix + entry.path !== module.path || entry.type !== module.type)
        throw new Error(`Module map descriptor disagrees with prepared module: ${module.name}`);
    }
  }
}
