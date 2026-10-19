import { decodeCodexManifest } from "./schemas.ts";
import type { CodexReleasePlan, HarnessReleasePlanInput, PreparedModuleType } from "./types.ts";
import {
  HarnessReleasePlanError,
  componentManifest,
  rawManifest,
  relativeModuleName,
  release,
  sameDescriptor,
  verifiedFile,
} from "./validation.ts";

function moduleType(name: string): PreparedModuleType {
  if (/\.(m?js)$/.test(name)) return "js";
  if (name.endsWith(".cjs")) return "cjs";
  if (name.endsWith(".wasm")) return "wasm";
  if (/\.(txt|json)$/.test(name)) return "text";
  throw new HarnessReleasePlanError(`Unsupported Codex runtime file: ${name}`);
}

export function codexPlan(input: HarnessReleasePlanInput): CodexReleasePlan {
  const manifestPath = componentManifest(input, "codex");
  const manifest = rawManifest(decodeCodexManifest, input.rawManifests.codex);
  const engine = manifest.files["engine.wasm"];
  if (
    engine === undefined ||
    !Object.hasOwn(manifest.files, "loader.mjs") ||
    !sameDescriptor(engine, { bytes: manifest.moduleBytes, sha256: manifest.moduleSha256 })
  )
    throw new HarnessReleasePlanError(
      "Codex engine/loader descriptors are missing or contradictory",
    );
  if (manifest.moduleBytes > manifest.moduleBudgetBytes)
    throw new HarnessReleasePlanError("Codex module budget passed contradicts module size");
  const preparedModules = Object.fromEntries(
    Object.entries(manifest.files).flatMap(([name, descriptor]) => {
      relativeModuleName(name);
      const file = verifiedFile(input, manifestPath, name, descriptor);
      // Cargo.lock records build provenance and is never imported by the native loader.
      if (name === "Cargo.lock") return [];
      return [
        [`codex/${name}`, { ...file, name, component: "codex" as const, type: moduleType(name) }],
      ];
    }),
  );
  return {
    harness: "codex",
    release: release(input, manifest.version, preparedModules),
    sourceIdentity: input.manifest.sourceIdentity,
    computer: { ...input.manifest.computer },
    preparedModules,
    assets: [],
    componentManifestPaths: { codex: manifestPath },
    engineModule: "codex/engine.wasm",
    loaderModule: "codex/loader.mjs",
    abiVersion: manifest.abiVersion,
    target: manifest.target,
    upstreamCommit: manifest.upstreamCommit,
    moduleBudgetBytes: manifest.moduleBudgetBytes,
  };
}
