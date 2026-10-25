import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const directory = NodeURL.fileURLToPath(new URL("./", import.meta.url));
const vendorDirectory = NodePath.join(directory, "vendor/node");
const generatedDirectory = NodePath.join(vendorDirectory, "generated");

const sources = [
  {
    file: "internal/fs/glob.js",
    output: "glob-core.ts",
    sourceHash: "b3b3ebcf41f691438f8d91555bbabb9cd22d04ed434448daa11e90198c7d732e",
    outputHash: "3455b4b6c8c7d9af969191c8985ccde0e207abdca3d8e5dbaab9a20fe3bf969f",
    wrap: (
      source,
    ) => `// @ts-nocheck - Node's pinned source is checked against its source and output hashes.
import type { NodeGlobCoreDependencies } from "../../../glob-contract.ts";

export function createNodeGlobModule(dependencies: NodeGlobCoreDependencies) {
  const { require } = dependencies;
  const { primordials } = dependencies;
  const nodeProcess = { platform: dependencies.platform };
  const module = { exports: Object.create(null) };
${source.replace(/^'use strict';\r?\n/u, "").replaceAll("process.platform", "nodeProcess.platform")}
  return module.exports;
}
`,
  },
  {
    file: "internal/deps/minimatch/index.js",
    output: "glob-matcher.ts",
    sourceHash: "23f1e425aa0813670574fe2c0241f591ef5463aacf2a23e3284654a49245fd4c",
    outputHash: "ec37102fc78152239c9173f2fffe232ab4e5136f567f948b0d760a9eb1a06f1b",
    wrap: (
      source,
    ) => `// @ts-nocheck - Node's pinned source is checked against its source and output hashes.
import type { NodeGlobMatcherModule } from "../../../glob-contract.ts";

export function createNodeMinimatchModule(): NodeGlobMatcherModule {
  const debugConsole = { error() {} };
  const module = { exports: Object.create(null) };
  const exports = module.exports;
${source.replace(/^"use strict";\r?\n/u, "").replaceAll("console.error", "debugConsole.error")}
  return module.exports;
}
`,
  },
];

function hash(contents) {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

export function renderGlobWrappers() {
  return sources.map((source) => {
    const sourcePath = NodePath.join(vendorDirectory, source.file);
    const contents = NodeFS.readFileSync(sourcePath, "utf8");
    const sourceHash = hash(contents);
    if (sourceHash !== source.sourceHash) {
      throw new Error(`Unexpected Node glob source hash for ${sourcePath}: ${sourceHash}`);
    }
    const output = source.wrap(contents);
    const outputHash = hash(output);
    if (outputHash !== source.outputHash) {
      throw new Error(
        `Unexpected generated Node glob wrapper hash for ${source.output}: ${outputHash}`,
      );
    }
    return {
      sourcePath,
      sourceHash,
      outputPath: NodePath.join(generatedDirectory, source.output),
      output,
    };
  });
}

export function verifyGlobWrappers() {
  for (const wrapper of renderGlobWrappers()) {
    let current;
    try {
      current = NodeFS.readFileSync(wrapper.outputPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Generated Node glob wrapper is missing: ${wrapper.outputPath}`, {
          cause: error,
        });
      }
      throw error;
    }
    if (current !== wrapper.output) {
      throw new Error(`Generated Node glob wrapper is stale: ${wrapper.outputPath}`);
    }
  }
}

function writeGlobWrappers() {
  NodeFS.mkdirSync(generatedDirectory, { recursive: true });
  for (const wrapper of renderGlobWrappers()) {
    NodeFS.writeFileSync(wrapper.outputPath, wrapper.output);
  }
}

if (NodeProcess.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  if (NodeProcess.argv.includes("--check")) verifyGlobWrappers();
  else writeGlobWrappers();
}
