import type { ReleaseFile } from "../../HarnessReleasePlan.ts";

export const hash = "a".repeat(64);
export const otherHash = "b".repeat(64);
export const descriptor = { bytes: 12, sha256: hash };
const computer = { sourceIdentity: "computer-source", manifestSha256: otherHash };

function common(harness: "codex" | "claude-code", files: Record<string, ReleaseFile>) {
  return {
    schemaVersion: 1 as const,
    harness,
    sourceIdentity: "provider-source",
    files,
    computer: { ...computer },
  };
}

export function codexInput() {
  const files = {
    "engine.wasm": { ...descriptor },
    "loader.mjs": { ...descriptor },
    "runtime/helper.mjs": { ...descriptor },
    "Cargo.lock": { ...descriptor },
  };
  return {
    artifactHash: hash,
    maxPreparedModuleBytes: 36,
    trustedComputer: { ...computer },
    manifest: {
      ...common(
        "codex",
        Object.fromEntries([
          ["codex/manifest.json", { ...descriptor }],
          ...Object.entries(files).map(([name, entry]) => [`codex/${name}`, { ...entry }]),
        ]),
      ),
      components: { codex: { manifest: "codex/manifest.json" } },
    },
    rawManifests: {
      codex: {
        abiVersion: 1,
        target: "wasm32-wasip1",
        version: "next-codex",
        upstreamCommit: "upstream-commit",
        moduleBytes: descriptor.bytes,
        moduleSha256: hash,
        moduleBudgetBytes: descriptor.bytes,
        moduleBudgetPassed: true,
        files,
      },
    },
  };
}

export function claudeInput() {
  const modules = {
    "claude.js": { ...descriptor, path: "cli-main.js", type: "js" },
    "worker.cjs": { ...descriptor, path: "worker.cjs", type: "cjs" },
    "data.txt": { ...descriptor, path: "data.txt", type: "text" },
    "engine.wasm": { ...descriptor, path: "engine.wasm", type: "wasm" },
  };
  const sdkModules = { "sdk.mjs": { ...descriptor, path: "sdk.mjs", type: "js" } };
  return {
    artifactHash: hash,
    maxPreparedModuleBytes: 60,
    trustedComputer: { ...computer },
    manifest: {
      ...common("claude-code", {
        "cli/manifest.json": { ...descriptor },
        "sdk/manifest.json": { ...descriptor },
        "cli/module-map.json": { ...descriptor },
        "cli/assets/help": { ...descriptor },
        ...Object.fromEntries(
          Object.values(modules).map((entry) => [`cli/${entry.path}`, { ...descriptor }]),
        ),
        "sdk/sdk.mjs": { ...descriptor },
      }),
      components: {
        cli: { manifest: "cli/manifest.json" },
        sdk: { manifest: "sdk/manifest.json" },
      },
    },
    rawManifests: {
      cli: {
        schemaVersion: 1,
        release: {
          provider: "claude-code",
          version: "next-cli",
          platform: "linux-x64",
          binarySha256: hash,
        },
        mainModule: "claude.js",
        mainExport: "launch",
        embeddedEntrypointExport: "launch",
        embeddedEntrypoints: { "/embedded/worker": "worker.cjs" },
        hostEntrypoints: { "host/worker": "worker.cjs" },
        moduleMap: { path: "module-map.json", sha256: hash },
        modules,
        assets: {
          "/help": { ...descriptor, path: "assets/help", key: "help", loader: 5, encoding: 0 },
        },
        requiredHostModules: ["node:fs"],
        environmentPackageModules: { "bun:jsc": { ...descriptor } },
        bytes: descriptor.bytes * Object.keys(modules).length,
      },
      sdk: {
        schemaVersion: 1,
        release: {
          provider: "agent-sdk",
          name: "@anthropic-ai/claude-agent-sdk",
          version: "next-sdk",
          integrity: "npm-integrity",
          tarballSha256: hash,
        },
        mainModule: "sdk.mjs",
        initializeExport: "initialize",
        modules: sdkModules,
        requiredHostModules: ["child_process"],
      },
    },
  };
}
