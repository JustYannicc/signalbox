import * as NodePath from "node:path";
import type { Metafile } from "esbuild";
import type { CombinedFixtureInput } from "./bundleInput.ts";

interface SourcePin {
  readonly bytes: number;
  readonly sha256: string;
}

/** Local paths are used for build verification, then replaced before evidence is written. */
export function buildEvidencePaths(input: {
  readonly repository: string;
  readonly workingDirectory: string;
  readonly outputDirectory: string;
  readonly sources: ReadonlyMap<string, SourcePin>;
}) {
  const names = new Map<string, string>();
  const sources: Record<string, SourcePin> = {};
  let dependency = 0;
  for (const [path, pin] of [...input.sources].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const relative = NodePath.relative(input.repository, path);
    const name =
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative)
        ? `repo/${relative.split(NodePath.sep).join("/")}`
        : `dependency/${++dependency}/${NodePath.basename(path)}`;
    if (Object.hasOwn(sources, name)) throw new Error("DEPLOY3_SOURCE_EVIDENCE_NAME_COLLISION");
    names.set(path, name);
    sources[name] = pin;
  }
  const sourceName = (path: string): string => {
    const name = names.get(NodePath.resolve(input.workingDirectory, path));
    if (name) return name;
    if (path === "deploy3:command-registry") return path;
    throw new Error("DEPLOY3_UNPINNED_METADATA_SOURCE");
  };
  const imports = (values: Metafile["inputs"][string]["imports"]) =>
    values.map(({ original: _original, ...value }) => ({
      ...value,
      path: value.external ? value.path : sourceName(value.path),
    }));
  const metafile = (value: Metafile): Metafile => ({
    inputs: Object.fromEntries(
      Object.entries(value.inputs).map(([path, entry]) => [
        sourceName(path),
        { ...entry, imports: imports(entry.imports) },
      ]),
    ),
    outputs: Object.fromEntries(
      Object.entries(value.outputs).map(([path, entry]) => {
        const relative = NodePath.relative(
          input.outputDirectory,
          NodePath.resolve(input.workingDirectory, path),
        );
        if (
          relative === ".." ||
          relative.startsWith(`..${NodePath.sep}`) ||
          NodePath.isAbsolute(relative)
        )
          throw new Error("DEPLOY3_METADATA_OUTPUT_OUTSIDE_BUILD");
        return [
          relative.split(NodePath.sep).join("/"),
          {
            ...entry,
            imports: entry.imports.map((item) => ({
              ...item,
              path: item.external ? item.path : sourceName(item.path),
            })),
            ...(entry.entryPoint === undefined ? {} : { entryPoint: sourceName(entry.entryPoint) }),
            inputs: Object.fromEntries(
              Object.entries(entry.inputs).map(([name, detail]) => [sourceName(name), detail]),
            ),
          },
        ];
      }),
    ),
  });
  return { sources, metafile };
}

export function buildInputEvidence(input: typeof CombinedFixtureInput.Type) {
  const pin = ({ bytes, sha256 }: SourcePin) => ({ bytes, sha256 });
  return {
    schema: input.schema,
    classification: input.classification,
    codex: {
      configuration: pin(input.codex.configuration),
      engine: pin(input.codex.engine),
      commands: input.codex.commands.map(pin),
    },
    claude: input.claude,
    claudeEnvironmentPackages: Object.fromEntries(
      Object.entries(input.claudeEnvironmentPackages).map(([name, file]) => [name, pin(file)]),
    ),
    claudeRuntime: {
      collectorNonce: input.claudeRuntime.collectorNonce,
      model: input.claudeRuntime.model,
      turnCount: {
        baseline: input.claudeRuntime.turnJson.baseline.length,
        hooks: input.claudeRuntime.turnJson.hooks.length,
      },
      seed: input.claudeRuntime.seed,
    },
  };
}
