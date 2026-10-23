import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { sha256 } from "./guards.ts";
import { integerSettingFromToml, type IntegerSetting } from "./codexMemoryToml.ts";
import {
  assignedDefault,
  clampedDefault,
  constantValue,
  functionBody,
  hasFunctionBodySequences,
  hasCanonicalSerdeName,
  hasCanonicalSerdeNameOnStruct,
  hasDerived,
  hasNoSerdeAttributes,
  hasNoSerdeAttributesOnStruct,
  hasSerdeDefault,
  hasSequence,
  isNumber,
  isOptionalNumber,
  listRustFiles,
  memberReadLines,
  structField,
  tokenizeRust,
  withoutTestOnlyItems,
  type Token,
} from "./codexMemorySource.ts";

export interface CodexMemorySettingEvidence {
  readonly key: string;
  readonly value: number;
  readonly fieldPath: string;
  readonly defaultPath: string;
  readonly productionReads: ReadonlyArray<{ readonly path: string; readonly line: number }>;
}

export interface CodexMemorySettingsEvidence {
  readonly schemaVersion: 1;
  readonly pins: Readonly<Record<string, number>>;
  readonly settings: ReadonlyArray<CodexMemorySettingEvidence>;
  readonly sources: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
  readonly packagedDefaults: {
    readonly path: string;
    readonly loaderPath: string;
    readonly sha256: string;
  };
}

type RustSource = { readonly source: string; readonly tokens: readonly Token[] };

function fail(kind: "MISSING" | "DEFAULT_CHANGED" | "DEFAULT_UNPROVEN", key: string): never {
  throw new Error(`RELEASE_MEMORY_SETTING_${kind}: ${key}`);
}

function schemaProperty(
  schema: unknown,
  parts: readonly string[],
): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  const root = schema as Record<string, unknown>;
  const properties = root.properties;
  if (properties === null || typeof properties !== "object") return undefined;
  let property = (properties as Record<string, unknown>)[parts[0]!];
  if (parts.length === 2) {
    const definitions = root.definitions;
    if (definitions === null || typeof definitions !== "object") return undefined;
    const memories = (definitions as Record<string, unknown>).MemoriesToml;
    if (memories === null || typeof memories !== "object") return undefined;
    const memoryProperties = (memories as Record<string, unknown>).properties;
    if (memoryProperties === null || typeof memoryProperties !== "object") return undefined;
    property = (memoryProperties as Record<string, unknown>)[parts[1]!];
  }
  return property !== null && typeof property === "object"
    ? (property as Record<string, unknown>)
    : undefined;
}

function schemaDefault(schema: unknown, parts: readonly string[]): IntegerSetting {
  const property = schemaProperty(schema, parts);
  if (!property) return { found: false };
  const value = property.default;
  return value === undefined
    ? { found: false }
    : typeof value === "number" && Number.isSafeInteger(value)
      ? { found: true, value }
      : { found: true, value: undefined };
}

async function readSource(root: string, path: string, key: string): Promise<string> {
  try {
    return await NodeFSP.readFile(NodePath.join(root, path), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") fail("MISSING", key);
    throw error;
  }
}

function hasConfigSerdeDefault(tokens: readonly Token[], field: string, key: string): number {
  const tomlField = structField(tokens, "ConfigToml", field);
  if (!tomlField || !isOptionalNumber(tomlField.tokens)) fail("MISSING", key);
  if (!hasCanonicalSerdeNameOnStruct(tokens, "ConfigToml") || !hasCanonicalSerdeName(tomlField))
    fail("DEFAULT_UNPROVEN", key);
  if (!hasSerdeDefault(tomlField, `default_${field}`)) fail("DEFAULT_UNPROVEN", key);
  const constant = `DEFAULT_${field.toUpperCase()}`;
  const defaultFunction = functionBody(tokens, `default_${field}`);
  if (
    !defaultFunction ||
    defaultFunction.length !== 4 ||
    !hasSequence(defaultFunction, ["Some", "(", constant, ")"])
  )
    fail("DEFAULT_UNPROVEN", key);
  const value = constantValue(tokens, constant);
  if (value === undefined) fail("DEFAULT_UNPROVEN", key);
  return value;
}

async function rustSources(root: string, key: string): Promise<Map<string, RustSource>> {
  const directories = ["codex-rs/core/src", "codex-rs/memories"];
  const paths = (
    await Promise.all(
      directories.map(async (directory) => {
        try {
          return await listRustFiles(NodePath.join(root, directory));
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            fail("MISSING", key);
          throw error;
        }
      }),
    )
  ).flat();
  const result = new Map<string, RustSource>();
  for (const absolutePath of paths) {
    const relative = NodePath.relative(root, absolutePath).split(NodePath.sep).join("/");
    const source = await NodeFSP.readFile(absolutePath, "utf8");
    result.set(relative, { source, tokens: tokenizeRust(source) });
  }
  return result;
}

export async function assertCodexMemorySettings(
  root: string,
  pins: Readonly<Record<string, number>>,
): Promise<CodexMemorySettingsEvidence> {
  const keys = Object.keys(pins).sort();
  if (!keys.length) fail("DEFAULT_UNPROVEN", "empty-pin-set");
  for (const key of keys) if (!Number.isSafeInteger(pins[key])) fail("DEFAULT_UNPROVEN", key);
  let base: string;
  try {
    base = await NodeFSP.realpath(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      fail("MISSING", keys[0]!);
    throw error;
  }

  const configPath = "codex-rs/config/src/config_toml.rs";
  const typesPath = "codex-rs/config/src/types.rs";
  const defaultsPath = "codex-rs/config/defaults.toml";
  const loaderPath = "codex-rs/config/src/loader/mod.rs";
  const schemaPath = "codex-rs/core/config.schema.json";
  const coreConfigPath = "codex-rs/core/src/config/mod.rs";
  const configSource = await readSource(base, configPath, keys[0]!);
  const typesSource = await readSource(base, typesPath, keys[0]!);
  const defaultsSource = await readSource(base, defaultsPath, keys[0]!);
  const loaderSource = await readSource(base, loaderPath, keys[0]!);
  const coreConfigSource = await readSource(base, coreConfigPath, keys[0]!);
  let schema: unknown;
  try {
    schema = JSON.parse(await NodeFSP.readFile(NodePath.join(base, schemaPath), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      if (error instanceof SyntaxError) fail("DEFAULT_UNPROVEN", keys[0]!);
      throw error;
    }
  }

  const config = tokenizeRust(configSource);
  const types = tokenizeRust(typesSource);
  const loader = tokenizeRust(loaderSource);
  const coreConfig = tokenizeRust(coreConfigSource);
  const memoriesKey = keys.find((key) => key.startsWith("memories."));
  const loaderIncludesDefaults = loader.some(
    (token, index) =>
      token.value === "include_str" &&
      loader[index + 1]?.value === "!" &&
      loader[index + 2]?.value === "(" &&
      loader[index + 3]?.kind === "string" &&
      loader[index + 3]?.value === "../../defaults.toml",
  );
  if (!loaderIncludesDefaults) fail("MISSING", keys[0]!);
  if (!hasDerived(config, "ConfigToml", "Deserialize")) fail("DEFAULT_UNPROVEN", keys[0]!);

  if (memoriesKey) {
    const configMemories = structField(config, "ConfigToml", "memories");
    const effectiveMemories = structField(coreConfig, "Config", "memories");
    const hasMemoryToml = hasDerived(types, "MemoriesToml", "Deserialize");
    if (
      !configMemories ||
      !hasSequence(configMemories.tokens, ["Option", "<", "MemoriesToml", ">"]) ||
      !hasMemoryToml ||
      !hasCanonicalSerdeNameOnStruct(config, "ConfigToml") ||
      !hasCanonicalSerdeName(configMemories) ||
      !hasNoSerdeAttributes(configMemories) ||
      !hasCanonicalSerdeNameOnStruct(types, "MemoriesToml") ||
      !hasNoSerdeAttributesOnStruct(config, "ConfigToml") ||
      !hasNoSerdeAttributesOnStruct(types, "MemoriesToml") ||
      !effectiveMemories ||
      !hasSequence(effectiveMemories.tokens, ["MemoriesConfig"]) ||
      !hasFunctionBodySequences(coreConfig, [
        [
          "let",
          "memories_config",
          ":",
          "MemoriesConfig",
          "=",
          "cfg",
          ".",
          "memories",
          ".",
          "clone",
          "(",
          ")",
          ".",
          "unwrap_or_default",
          "(",
          ")",
          ".",
          "into",
          "(",
          ")",
        ],
        ["memories", ":", "memories_config"],
      ])
    ) {
      fail("DEFAULT_UNPROVEN", memoriesKey);
    }
  }
  if (keys.includes("project_doc_max_bytes")) {
    const projectValue = hasConfigSerdeDefault(
      config,
      "project_doc_max_bytes",
      "project_doc_max_bytes",
    );
    const configField = structField(coreConfig, "Config", "project_doc_max_bytes");
    if (
      !configField ||
      !isNumber(configField.tokens) ||
      !hasFunctionBodySequences(coreConfig, [
        ["project_doc_max_bytes", ":", "cfg", ".", "project_doc_max_bytes", ".", "unwrap_or"],
      ])
    ) {
      fail("DEFAULT_UNPROVEN", "project_doc_max_bytes");
    }
    if (projectValue !== pins.project_doc_max_bytes)
      fail("DEFAULT_CHANGED", "project_doc_max_bytes");
  }

  const sources = await rustSources(base, keys[0]!);
  const output: CodexMemorySettingEvidence[] = [];
  const hashes = new Map<string, string>();
  const addHash = async (path: string, bytes: string | Uint8Array) =>
    hashes.set(path, sha256(bytes));
  for (const key of keys) {
    const parts = key.split(".");
    if (parts.some((part) => !/^[a-z_]+$/u.test(part)) || parts.length > 2)
      fail("DEFAULT_UNPROVEN", key);
    const leaf = parts.at(-1)!;
    const group = parts.length === 2 ? parts[0] : undefined;
    const expected = pins[key]!;
    let value: number;
    let fieldPath: string;
    let defaultPath: string;
    if (group) {
      if (group !== "memories") fail("DEFAULT_UNPROVEN", key);
      const tomlField = structField(types, "MemoriesToml", leaf);
      const effectiveField = structField(types, "MemoriesConfig", leaf);
      const constant = `DEFAULT_${group.toUpperCase()}_${leaf.toUpperCase()}`;
      const nativeDefault = constantValue(types, constant);
      if (!tomlField || !effectiveField) fail("MISSING", key);
      if (
        !isOptionalNumber(tomlField.tokens) ||
        !isNumber(effectiveField.tokens) ||
        !hasCanonicalSerdeName(tomlField) ||
        !hasNoSerdeAttributes(tomlField) ||
        !assignedDefault(types, "Default", leaf, constant)
      ) {
        fail("DEFAULT_UNPROVEN", key);
      }
      if (nativeDefault === undefined) {
        const declared = types.some(
          (token, index) => token.value === "const" && types[index + 1]?.value === constant,
        );
        fail(declared ? "DEFAULT_UNPROVEN" : "MISSING", key);
      }
      const effectiveDefault = clampedDefault(types, leaf, constant);
      if (effectiveDefault === undefined) fail("DEFAULT_UNPROVEN", key);
      value = effectiveDefault;
      fieldPath = `${typesPath}::MemoriesToml.${leaf}`;
      defaultPath = `${typesPath}::MemoriesConfig::default().${leaf}`;
    } else {
      value = hasConfigSerdeDefault(config, leaf, key);
      fieldPath = `${configPath}::ConfigToml.${leaf}`;
      defaultPath = `${configPath}::DEFAULT_${leaf.toUpperCase()}`;
    }
    if (value !== expected) fail("DEFAULT_CHANGED", key);

    const packaged = integerSettingFromToml(defaultsSource, key);
    if (packaged.found) {
      if (packaged.value === undefined) fail("DEFAULT_UNPROVEN", key);
      if (packaged.value !== expected) fail("DEFAULT_CHANGED", key);
    }
    const schemaResult = schemaDefault(schema, parts);
    if (schemaResult.found) {
      if (schemaResult.value === undefined) fail("DEFAULT_UNPROVEN", key);
      if (schemaResult.value !== expected) fail("DEFAULT_CHANGED", key);
    }
    if (schema !== undefined && !schemaProperty(schema, parts)) fail("MISSING", key);

    const productionReads: Array<{ path: string; line: number }> = [];
    const ownerPaths = group
      ? [
          { path: ["config", ".", "memories", "."], type: "Config" },
          { path: ["memories_config", "."], type: "MemoriesConfig" },
        ]
      : [{ path: ["config", "."], type: "Config" }];
    for (const [path, source] of sources) {
      const inRuntime = group
        ? path.startsWith("codex-rs/memories/")
        : path.startsWith("codex-rs/core/src/") && path !== coreConfigPath;
      if (!inRuntime) continue;
      const lines = memberReadLines(withoutTestOnlyItems(source.tokens), leaf, ownerPaths);
      for (const line of lines) productionReads.push({ path, line });
      if (lines.length) await addHash(path, source.source);
    }
    if (!productionReads.length) fail("MISSING", key);

    output.push({ key, value, fieldPath, defaultPath, productionReads });
    await addHash(configPath, configSource);
    await addHash(typesPath, typesSource);
    await addHash(defaultsPath, defaultsSource);
    await addHash(loaderPath, loaderSource);
    await addHash(coreConfigPath, coreConfigSource);
    if (schema !== undefined)
      await addHash(schemaPath, await NodeFSP.readFile(NodePath.join(base, schemaPath)));
  }

  return {
    schemaVersion: 1,
    pins: Object.fromEntries(keys.map((key) => [key, pins[key]!])),
    settings: output,
    sources: [...hashes]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, hash]) => ({ path, sha256: hash })),
    packagedDefaults: { path: defaultsPath, loaderPath, sha256: sha256(defaultsSource) },
  };
}
