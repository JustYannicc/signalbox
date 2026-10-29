import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import { buildNodeSdk, type NpmSdkSource } from "../../src/isolate/NodeSdkBuild.ts";
import { verifyClaudeSdkNpmSource } from "./claudeSdkNpmSource.ts";
import { rewriteClaudeSdkCreateRequire } from "./claudeSdkCreateRequire.ts";

interface NodeSdkBuildInput {
  readonly source: NpmSdkSource;
  readonly dependencies?: ReadonlyArray<NpmSdkSource>;
  readonly nodeModulesRoot?: string;
  readonly output: string;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string) {
  if (typeof value !== "string" || !value) throw new Error(code);
  return value;
}

function source(value: unknown): NpmSdkSource {
  const input = record(value, "NODE_SDK_BUILD_INPUT_INVALID");
  return {
    name: text(input.name, "NODE_SDK_BUILD_INPUT_INVALID"),
    version: text(input.version, "NODE_SDK_BUILD_INPUT_INVALID"),
    integrity: text(input.integrity, "NODE_SDK_BUILD_INPUT_INVALID"),
    root: text(input.root, "NODE_SDK_BUILD_INPUT_INVALID"),
    tarball: text(input.tarball, "NODE_SDK_BUILD_INPUT_INVALID"),
  };
}

function inputOptions(value: unknown): NodeSdkBuildInput {
  const input = record(value, "NODE_SDK_BUILD_INPUT_INVALID");
  if (input.dependencies !== undefined && !Array.isArray(input.dependencies))
    throw new Error("NODE_SDK_BUILD_INPUT_INVALID");
  return {
    source: source(input.source),
    ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies.map(source) }),
    ...(input.nodeModulesRoot === undefined
      ? {}
      : { nodeModulesRoot: text(input.nodeModulesRoot, "NODE_SDK_BUILD_INPUT_INVALID") }),
    output: text(input.output, "NODE_SDK_BUILD_INPUT_INVALID"),
  };
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: { input: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  if (!values.input)
    throw new Error(
      "Usage: node apps/cloud/infra/harnessReleases/buildClaudeSdkBundle.ts --input <request.json>",
    );
  const request = JSON.parse(await NodeFSP.readFile(values.input, "utf8"));
  const input = inputOptions(request);
  const verified = await Promise.all(
    [input.source, ...(input.dependencies ?? [])].map(verifyClaudeSdkNpmSource),
  );
  const result = await buildNodeSdk({
    source: verified[0]!,
    dependencies: verified.slice(1),
    ...(input.nodeModulesRoot ? { nodeModulesRoot: input.nodeModulesRoot } : {}),
    output: input.output,
    transformSource: (source) => rewriteClaudeSdkCreateRequire(source),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entryPath = process.argv[1]
  ? await NodeFSP.realpath(process.argv[1]).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return undefined;
      throw error;
    })
  : undefined;
if (entryPath && entryPath === import.meta.filename) await main();
