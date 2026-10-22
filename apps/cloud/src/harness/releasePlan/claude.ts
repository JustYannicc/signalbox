import * as Schema from "effect/Schema";
import { ReleaseOmissionConfiguration } from "@t3tools/contracts/harnessReleaseOmission";
import { matchesClaudeHostConfiguration } from "../ClaudeHostConfig.ts";
import { decodeCliManifest, decodeSdkManifest } from "./schemas.ts";
import type {
  ClaudeReleasePlan,
  HarnessReleasePlanInput,
  PreparedReleaseModule,
  ReleaseComponent,
} from "./types.ts";
import {
  HarnessReleasePlanError,
  componentManifest,
  declaredEntrypoint,
  rawManifest,
  relativeModuleName,
  release,
  verifiedFile,
} from "./validation.ts";

const decodeOmission = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    configuration: ReleaseOmissionConfiguration,
  }),
  { reportInput: false },
);

export function claudePlan(input: HarnessReleasePlanInput): ClaudeReleasePlan {
  const cliPath = componentManifest(input, "cli");
  const sdkPath = componentManifest(input, "sdk");
  const cli = rawManifest(decodeCliManifest, input.rawManifests.cli);
  const sdk = rawManifest(decodeSdkManifest, input.rawManifests.sdk);
  let omissionConfiguration: ReleaseOmissionConfiguration | undefined;
  if (cli.omission !== undefined) {
    try {
      omissionConfiguration = decodeOmission(cli.omission).configuration;
    } catch (cause) {
      throw new HarnessReleasePlanError("Invalid Claude release omission", cause);
    }
  }
  if (
    (cli.omission === undefined) !== (input.manifest.omission === undefined) ||
    omissionConfiguration?.name !== input.manifest.omission?.configuration.name
  ) {
    throw new HarnessReleasePlanError(
      "Claude omission identity does not match the common manifest",
    );
  }
  if (omissionConfiguration && omissionConfiguration.name !== "product") {
    throw new HarnessReleasePlanError("Claude release configuration is not product-enabled");
  }
  if (omissionConfiguration && !matchesClaudeHostConfiguration(omissionConfiguration)) {
    throw new HarnessReleasePlanError(
      "Claude release configuration does not match the product host",
    );
  }
  for (const name of [...Object.keys(cli.modules), ...Object.keys(sdk.modules)])
    relativeModuleName(name);
  if (cli.mainExport !== "launch" || cli.embeddedEntrypointExport !== "launch")
    throw new HarnessReleasePlanError("Claude CLI must declare launch exports");
  if (sdk.initializeExport !== "initialize")
    throw new HarnessReleasePlanError("Claude SDK must declare its initialize export");
  for (const name of Object.keys(sdk.modules)) {
    if (Object.hasOwn(cli.modules, name))
      throw new HarnessReleasePlanError(`SDK/CLI module name collision: ${name}`);
  }
  const preparedModules: Record<string, PreparedReleaseModule> = {};
  const paths = new Set<string>();
  const addModules = (
    component: ReleaseComponent,
    manifestPath: string,
    modules: typeof cli.modules,
  ) => {
    for (const [name, entry] of Object.entries(modules)) {
      const file = verifiedFile(input, manifestPath, entry.path, entry);
      if (paths.has(file.path))
        throw new HarnessReleasePlanError(`Module payload collision: ${file.path}`);
      paths.add(file.path);
      preparedModules[`${component}/${name}`] = { ...file, component, name, type: entry.type };
    }
  };
  addModules("cli", cliPath, cli.modules);
  addModules("sdk", sdkPath, sdk.modules);
  if (cli.bytes !== Object.values(cli.modules).reduce((total, entry) => total + entry.bytes, 0))
    throw new HarnessReleasePlanError("Claude CLI total module bytes contradict descriptors");
  const moduleMaps = [
    {
      component: "cli" as const,
      name: cli.moduleMap.path,
      ...verifiedFile(input, cliPath, cli.moduleMap.path, cli.moduleMap),
    },
    ...(sdk.moduleMap === undefined
      ? []
      : [
          {
            component: "sdk" as const,
            name: sdk.moduleMap.path,
            ...verifiedFile(input, sdkPath, sdk.moduleMap.path, sdk.moduleMap),
          },
        ]),
  ];
  const assets = Object.entries(cli.assets).map(([name, entry]) => ({
    ...verifiedFile(input, cliPath, entry.path, entry),
    component: "cli" as const,
    name,
    key: entry.key,
    loader: entry.loader,
    encoding: entry.encoding,
  }));
  const entrypoints = (entries: Readonly<Record<string, string>>) =>
    Object.fromEntries(
      Object.entries(entries).map(([name, module]) => [
        name,
        declaredEntrypoint("cli", module, cli.modules),
      ]),
    );
  return {
    harness: "claude-code",
    release: release(input, cli.release.version, preparedModules),
    sourceIdentity: input.manifest.sourceIdentity,
    computer: { ...input.manifest.computer },
    preparedModules,
    assets,
    componentManifestPaths: { cli: cliPath, sdk: sdkPath },
    main: {
      module: declaredEntrypoint("cli", cli.mainModule, cli.modules),
      export: cli.mainExport,
    },
    initialize: {
      module: declaredEntrypoint("sdk", sdk.mainModule, sdk.modules),
      export: sdk.initializeExport,
    },
    embeddedEntrypointExport: cli.embeddedEntrypointExport,
    embeddedEntrypoints: entrypoints(cli.embeddedEntrypoints),
    hostEntrypoints: entrypoints(cli.hostEntrypoints),
    moduleMaps,
    requiredHostModules: { cli: cli.requiredHostModules, sdk: sdk.requiredHostModules },
    environmentPackageModules: cli.environmentPackageModules,
    cli: cli.release,
    sdk: sdk.release,
  };
}
