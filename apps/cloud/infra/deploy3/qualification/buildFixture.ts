import {
  CLAUDE_FIXTURE_BINDINGS,
  requireFixtureMcpProbe,
} from "./fixture/claudeFixtureServices.ts";
import { decodeBaseConfiguration } from "./fixture/configuration.schema.ts";
import { verifySeedConfiguration } from "./fixture/seedConfiguration.ts";
import { validateMachineProgramInventory } from "../../../src/computer/MachineProgramInventory.ts";
import { buildEvidencePaths, buildInputEvidence } from "./buildEvidence.ts";
import { validateClaudeFixtureTurns } from "./validateClaudeTurns.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build, type BuildOptions, type Metafile, type Plugin } from "esbuild";
import * as Schema from "effect/Schema";
import { productLoadedPreparedRelease } from "../../../src/harness/ProductHarnessProcessRelease.ts";
import { decodeCombinedFixtureInput, type FixtureFilePin } from "./bundleInput.ts";
import { inspectDeploy3AssetRoot } from "./inspectAssets.ts";
import { decodePreparedRelease } from "./preparedRelease.schema.ts";
import { prepareEnvironmentPackages } from "./environmentPackages.ts";

const source = NodeURL.fileURLToPath(new URL("./fixture/", import.meta.url));
const cloud = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const decodeCommandHashes = Schema.decodeUnknownSync(Schema.Array(Schema.String));

async function readFile(pin: typeof FixtureFilePin.Type) {
  const bytes = await NodeFSP.readFile(pin.path);
  if (bytes.length !== pin.bytes || hash(bytes) !== pin.sha256)
    throw new Error(`DEPLOY3_CHANGED_INPUT: ${pin.path}`);
  return bytes;
}

/** Builds code and pinned assets only. Launching or deploying the result is a separate action. */
export async function buildCombinedFixture(raw: unknown) {
  const input = decodeCombinedFixtureInput(structuredClone(raw));
  if (input.claude.assets.status !== "supplied" || input.claude.assets.purpose !== "qualification")
    throw new Error("DEPLOY3_QUALIFICATION_ASSETS_REQUIRED");
  requireFixtureMcpProbe(input.claudeRuntime.mcpProbe);
  validateClaudeFixtureTurns(input.claudeRuntime);
  const inspected = await inspectDeploy3AssetRoot(input.assetsDirectory, input.claude);
  const configurationBytes = await readFile(input.codex.configuration);
  const configuration = decodeBaseConfiguration(JSON.parse(configurationBytes.toString("utf8")));
  validateMachineProgramInventory(configuration.machineInventory);
  await verifySeedConfiguration(configuration.seed);
  const expectedRelease = decodePreparedRelease(Reflect.get(configuration, "expectedRelease"));
  const expectedCommands = decodeCommandHashes(Reflect.get(configuration, "commandRegistryHashes"));
  if (
    JSON.stringify([...expectedCommands].sort()) !==
    JSON.stringify(input.codex.commands.map((pin) => pin.sha256).sort())
  )
    throw new Error("DEPLOY3_COMMAND_REGISTRY_MISMATCH");
  const trustedComputer = input.claude.assets.trustedComputer;
  if (
    expectedRelease.plan.computer.sourceIdentity !== trustedComputer.sourceIdentity ||
    expectedRelease.plan.computer.manifestSha256 !== trustedComputer.manifestSha256
  )
    throw new Error("DEPLOY3_COMPUTER_IDENTITY_MISMATCH");
  const engineDescriptor = Object.values(expectedRelease.plan.preparedModules).find(
    (module) =>
      module.component === "codex" &&
      module.type === "wasm" &&
      module.path.endsWith("codex/engine.wasm"),
  );
  if (
    expectedRelease.artifact.provider !== "codex" ||
    !engineDescriptor ||
    engineDescriptor.bytes !== input.codex.engine.bytes ||
    engineDescriptor.sha256 !== input.codex.engine.sha256
  )
    throw new Error("DEPLOY3_CODEX_ENGINE_IDENTITY_MISMATCH");
  const engine = await readFile(input.codex.engine);
  const commands = await Promise.all(input.codex.commands.map(readFile));
  if (new Set(input.codex.commands.map((pin) => pin.sha256)).size !== commands.length)
    throw new Error("DEPLOY3_DUPLICATE_COMMAND_MODULE");
  const variants = inspected.loaded.releaseVariants.catalog;
  const claudeExpected = {
    baseline: productLoadedPreparedRelease("claude-code", variants.baseline.fullArtifact, {
      plan: inspected.loaded.baseline.plan,
      payloads: new Map(),
    }),
    hooks: productLoadedPreparedRelease("claude-code", variants.hooks.fullArtifact, {
      plan: inspected.loaded.hooks.plan,
      payloads: new Map(),
    }),
  };
  const environmentPackages = await prepareEnvironmentPackages(input.claudeEnvironmentPackages, [
    inspected.loaded.baseline.plan,
    inspected.loaded.hooks.plan,
  ]);

  await NodeFSP.mkdir(input.outputDirectory);
  const output = input.outputDirectory;
  await NodeFSP.mkdir(NodePath.join(output, "programs"));
  await NodeFSP.writeFile(NodePath.join(output, "codex-engine.wasm"), engine, { flag: "wx" });
  for (const [index, pin] of input.codex.commands.entries())
    await NodeFSP.writeFile(
      NodePath.join(output, "programs", `${pin.sha256}.wasm`),
      commands[index]!,
      {
        flag: "wx",
      },
    );

  const registry = [
    ...input.codex.commands.map(
      (pin, index) => `import m${index} from ${JSON.stringify(`./programs/${pin.sha256}.wasm`)};`,
    ),
    `export const COMMAND_REGISTRY = new Map([${input.codex.commands.map((pin, index) => `[${JSON.stringify(pin.sha256)},m${index}]`).join(",")}]);`,
  ].join("\n");
  const sources = new Map<string, { bytes: number; sha256: string }>();
  const registryPlugin: Plugin = {
    name: "pinned-command-registry",
    setup(api) {
      api.onResolve({ filter: /^signalbox:deploy3-command-registry$/ }, (args) =>
        args.importer === NodePath.join(source, "programRegistry.ts")
          ? { path: "command-registry", namespace: "deploy3" }
          : undefined,
      );
      api.onLoad({ filter: /.*/, namespace: "deploy3" }, () => ({
        contents: registry,
        loader: "js",
      }));
      api.onLoad(
        { filter: /\.(?:ts|tsx|js|jsx|mjs|cjs|json)$/, namespace: "file" },
        async (args) => {
          const contents = await NodeFSP.readFile(args.path);
          const pin = { bytes: contents.length, sha256: hash(contents) };
          const previous = sources.get(args.path);
          if (previous && (previous.bytes !== pin.bytes || previous.sha256 !== pin.sha256))
            throw new Error(`DEPLOY3_SOURCE_CHANGED_DURING_BUILD: ${args.path}`);
          sources.set(args.path, pin);
          const extension = NodePath.extname(args.path);
          const loader =
            extension === ".ts"
              ? "ts"
              : extension === ".tsx"
                ? "tsx"
                : extension === ".jsx"
                  ? "jsx"
                  : extension === ".json"
                    ? "json"
                    : "js";
          return { contents, loader, resolveDir: NodePath.dirname(args.path) };
        },
      );
    },
  };
  const common: BuildOptions = {
    absWorkingDir: cloud,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers", "./codex-engine.wasm", "./programs/*.wasm", "node:*"],
    nodePaths: [NodePath.join(cloud, "node_modules")],
    tsconfig: NodePath.join(cloud, "tsconfig.json"),
    metafile: true,
    plugins: [registryPlugin],
  };
  const metafiles: Record<string, Metafile> = {};
  for (const [entry, name] of [
    ["facet", "qualifier-implementation"],
    ["claudeFacet", "qualifier-claude-implementation"],
    ["worker", "qualifier-worker"],
  ] as const) {
    const built = await build({
      ...common,
      entryPoints: [NodePath.join(source, `${entry}.ts`)],
      outfile: NodePath.join(output, `${name}.mjs`),
    });
    if (!built.metafile) throw new Error("DEPLOY3_BUILD_METADATA_MISSING");
    metafiles[name] = built.metafile;
  }
  const workflow = await build({
    ...common,
    platform: "node",
    conditions: ["node"],
    entryPoints: [NodePath.join(source, "claudeWorkflow.ts")],
    outfile: NodePath.join(output, "qualifier-claude-workflow.mjs"),
  });
  if (!workflow.metafile) throw new Error("DEPLOY3_WORKFLOW_BUILD_METADATA_MISSING");
  metafiles["qualifier-claude-workflow"] = workflow.metafile;
  const production = await build({
    entryPoints: [NodePath.join(cloud, "src/worker.ts")],
    bundle: false,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    tsconfig: NodePath.join(cloud, "tsconfig.json"),
  });
  const productionExports = Object.values(production.metafile?.outputs ?? {}).flatMap(
    (value) => value.exports,
  );
  const fixtureExports = new Set(
    Object.values(metafiles["qualifier-worker"]!.outputs).flatMap((value) => value.exports),
  );
  if (!productionExports.length || productionExports.some((name) => !fixtureExports.has(name)))
    throw new Error("DEPLOY3_PRODUCTION_EXPORTS_MISSING");
  const config = {
    ...configuration,
    expectedRelease,
    facetSource: await NodeFSP.readFile(
      NodePath.join(output, "qualifier-implementation.mjs"),
      "utf8",
    ),
    claude: {
      runtime: {
        schema: "sb1070/deploy3-claude-facet/v1",
        purpose: "qualification",
        assets: input.claude,
        workload: {
          collectorNonce: input.claudeRuntime.collectorNonce,
          mcpProbe: input.claudeRuntime.mcpProbe,
          apiRevision: "EC1APIr2",
          model: input.claudeRuntime.model,
        },
        turnJson: input.claudeRuntime.turnJson,
        seed: input.claudeRuntime.seed,
      },
      environmentPackages: environmentPackages.assets,
      facetSource: await NodeFSP.readFile(
        NodePath.join(output, "qualifier-claude-implementation.mjs"),
        "utf8",
      ),
      expected: claudeExpected,
    },
  };
  const assets = NodePath.join(output, "assets");
  await NodeFSP.cp(input.assetsDirectory, assets, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await NodeFSP.mkdir(NodePath.join(assets, "qualifier"), { recursive: true });
  await environmentPackages.write(assets);
  const configBytes = Buffer.from(json(config));
  await NodeFSP.writeFile(NodePath.join(assets, "qualifier/config.json"), configBytes, {
    flag: "wx",
  });
  const final = await inspectDeploy3AssetRoot(assets, input.claude);
  for (const [path, pin] of sources) {
    const bytes = await NodeFSP.readFile(path);
    if (bytes.length !== pin.bytes || hash(bytes) !== pin.sha256)
      throw new Error(`DEPLOY3_SOURCE_CHANGED_AFTER_BUILD: ${path}`);
  }
  const outputs = [];
  for (const name of [
    "qualifier-implementation",
    "qualifier-claude-implementation",
    "qualifier-worker",
    "qualifier-claude-workflow",
  ]) {
    const path = `${name}.mjs`;
    const bytes = await NodeFSP.readFile(NodePath.join(output, path));
    outputs.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const evidence = buildEvidencePaths({
    repository: NodePath.resolve(cloud, "../.."),
    workingDirectory: cloud,
    outputDirectory: output,
    sources,
  });
  const publicMetafiles = Object.fromEntries(
    Object.entries(metafiles).map(([name, value]) => [name, evidence.metafile(value)]),
  );
  for (const [name, value] of Object.entries(publicMetafiles))
    await NodeFSP.writeFile(NodePath.join(output, `${name}.metafile.json`), json(value), {
      flag: "wx",
    });
  const manifest = {
    schema: "signalbox/deploy3-combined-build/v1",
    classification: input.classification,
    nativeStarted: false,
    qualification: "not-run",
    releasable: inspected.loaded.releasable,
    openFindingRecords: {
      baseline: inspected.loaded.openFindings.baseline.length,
      hooks: inspected.loaded.openFindings.hooks.length,
      metadata: inspected.loaded.metadata,
    },
    deploymentReady: false,
    input: buildInputEvidence(input),
    fixtureBindings: CLAUDE_FIXTURE_BINDINGS,
    configSha256: hash(configBytes),
    inventory: final.inventory,
    sources: evidence.sources,
    outputs,
    metafiles: publicMetafiles,
  };
  await NodeFSP.writeFile(NodePath.join(output, "build.json"), json(manifest), { flag: "wx" });
  return manifest;
}
