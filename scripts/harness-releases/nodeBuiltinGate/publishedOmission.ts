import { Schema } from "effect";
import { ReleaseOmissionConfiguration } from "@t3tools/contracts/harnessReleaseOmission";
import { digest, record, text } from "../guards.ts";
import type { ReleaseOmissionManifest } from "../../claude-bunfs/release-omission.ts";

const invalid = "NODE_BUILTIN_PUBLISHED_MANIFEST_INVALID";
const decodeConfiguration = Schema.decodeUnknownSync(ReleaseOmissionConfiguration, {
  onExcessProperty: "error",
});

function exactRecord(value: unknown, keys: readonly string[]) {
  const result = record(value, invalid);
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
    throw new Error(invalid);
  return result;
}

function stringList(value: unknown, allowEmpty = false) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || (!allowEmpty && item.length === 0))
  )
    throw new Error(invalid);
}

function hashList(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(invalid);
  return value.map((raw) => {
    const item = exactRecord(raw, ["name", "sha256"]);
    return {
      name: text(item.name, invalid),
      sha256: digest(item.sha256, invalid),
    };
  });
}

/** Keep the final artifact's omission evidence intact, but reject unknown or partial shapes. */
export function readPublishedOmission(value: unknown): ReleaseOmissionManifest | undefined {
  if (value === undefined) return undefined;
  const omission = exactRecord(value, [
    "schemaVersion",
    "configuration",
    "configurationReplacements",
    "configurationRemoved",
    "corpus",
    "omittedModules",
  ]);
  if (omission.schemaVersion !== 1) throw new Error(invalid);

  try {
    decodeConfiguration(omission.configuration);
  } catch {
    throw new Error(invalid);
  }

  const replacements = record(omission.configurationReplacements, invalid);
  if (
    Object.values(replacements).some(
      (item) => typeof item !== "number" || !Number.isSafeInteger(item) || item < 0,
    )
  )
    throw new Error(invalid);
  stringList(omission.configurationRemoved);

  let hasCorpus = false;
  if (omission.corpus !== null) {
    hasCorpus = true;
    const corpus = exactRecord(omission.corpus, [
      "binarySha256",
      "sha256",
      "provenance",
      "pending",
    ]);
    digest(corpus.binarySha256, invalid);
    digest(corpus.sha256, invalid);
    hashList(corpus.provenance);
    stringList(corpus.pending, true);
  }

  if (!Array.isArray(omission.omittedModules)) throw new Error(invalid);
  const seen = new Set<string>();
  for (const raw of omission.omittedModules) {
    const module = exactRecord(raw, ["inputPath", "tier", "sourceBytes", "sourceSha256"]);
    const inputPath = text(module.inputPath, invalid);
    if (
      seen.has(inputPath) ||
      (module.tier !== "configuration" && module.tier !== "corpus") ||
      (module.tier === "corpus" && !hasCorpus) ||
      typeof module.sourceBytes !== "number" ||
      !Number.isSafeInteger(module.sourceBytes) ||
      module.sourceBytes < 0
    )
      throw new Error(invalid);
    seen.add(inputPath);
    digest(module.sourceSha256, invalid);
  }

  return omission as unknown as ReleaseOmissionManifest;
}
