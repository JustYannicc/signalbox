import type * as Esbuild from "esbuild";
import { createPinnedEnvironmentTransform } from "./pinned-environment.ts";
import {
  omittedModuleSource,
  parseReleaseCoverageCorpus,
  releaseSourceHash,
  type OmittedReleaseChunk,
  type ReleaseOmissionManifest,
  type ReleaseOmissionOptions,
} from "./release-omission.ts";

const contributed = (metafile: Esbuild.Metafile) =>
  new Set(
    Object.values(metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, value]) => value.bytesInOutput > 0)
        .map(([name]) => name),
    ),
  );

/** Keeps source caching, static elimination and coverage omission on the same graph builds. */
export function createReleaseOmission(input: {
  readonly options: ReleaseOmissionOptions;
  readonly binarySha256: string;
  readonly sources: ReadonlyMap<string, string>;
  readonly resolve: (specifier: string, importer: string) => string | undefined;
  readonly commonJs: (path: string) => boolean;
}) {
  const { options } = input;
  const corpus = options.corpus ? parseReleaseCoverageCorpus(options.corpus) : undefined;
  if (corpus && corpus.binarySha256 !== input.binarySha256)
    throw new Error("RELEASE_CORPUS_BINARY_MISMATCH");
  const pinned = createPinnedEnvironmentTransform(
    input.sources,
    options.configuration.env,
    input.resolve,
  );
  let specialize = false;
  let configurationRemoved: string[] = [];
  const omitted = new Map<string, OmittedReleaseChunk>();
  const originals = new Map<string, string>();
  const specialized = new Map<string, string>();
  const stubs = new Map<string, string>();
  const prepareSource = (source: string, path: string, namespace: string) => {
    const id = `${namespace}:${path}`;
    originals.set(id, source);
    const chunk = omitted.get(id);
    if (chunk) {
      let stub = stubs.get(id);
      if (stub === undefined)
        stubs.set(
          id,
          (stub = omittedModuleSource(
            source,
            chunk,
            input.commonJs(path) ||
              (/\bmodule\.exports\b/.test(source) && namespace === "signalbox-environment-package"),
          )),
        );
      return stub;
    }
    if (!specialize) return source;
    let result = specialized.get(id);
    if (result === undefined) specialized.set(id, (result = pinned.transform(source, path)));
    return result;
  };
  const plan = async <T extends { metafile: Esbuild.Metafile }>(build: () => Promise<T>) => {
    const baseline = await build();
    specialize = true;
    const configured = await build();
    const remaining = contributed(configured.metafile);
    configurationRemoved = [...contributed(baseline.metafile)]
      .filter((name) => !remaining.has(name) && originals.has(name))
      .sort();
    const add = (inputPath: string, tier: OmittedReleaseChunk["tier"]) => {
      if (omitted.has(inputPath)) return;
      const source = originals.get(inputPath);
      if (source === undefined) throw new Error(`RELEASE_CORPUS_INPUT_UNKNOWN: ${inputPath}`);
      omitted.set(inputPath, {
        chunkId: inputPath,
        inputPath,
        tier,
        sourceBytes: new TextEncoder().encode(source).byteLength,
        sourceSha256: releaseSourceHash(source),
      });
    };
    for (const name of configurationRemoved) add(name, "configuration");
    for (const row of corpus?.inputs ?? []) {
      if (!originals.has(row.inputPath))
        throw new Error(`RELEASE_CORPUS_INPUT_UNKNOWN: ${row.inputPath}`);
      if (!row.initialized) add(row.inputPath, "corpus");
    }
    pinned.releaseAnalysis();
    return build();
  };
  const manifest = (): ReleaseOmissionManifest => ({
    schemaVersion: 1,
    configuration: options.configuration,
    configurationReplacements: pinned.report(),
    configurationRemoved,
    corpus: corpus
      ? {
          sha256: releaseSourceHash(JSON.stringify(corpus)),
          provenance: corpus.provenance,
          pending: corpus.pending,
        }
      : null,
    chunks: [...omitted.values()].sort((a, b) => a.inputPath.localeCompare(b.inputPath)),
  });
  return { prepareSource, plan, manifest };
}
