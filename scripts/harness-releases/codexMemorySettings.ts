import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { sha256 } from "./guards.ts";

const KEY = "project_doc_max_bytes";
const CONFIG = "codex-rs/config/src/config_toml.rs";
const DEFAULTS = "codex-rs/config/defaults.toml";
const LOADER = "codex-rs/config/src/loader/mod.rs";
const CORE = "codex-rs/core/src/config/mod.rs";
const AGENTS = "codex-rs/core/src/agents_md.rs";
type Failure = "MISSING" | "DEFAULT_CHANGED" | "DEFAULT_UNPROVEN";

function fail(kind: Failure, key = KEY): never {
  throw new Error(`RELEASE_MEMORY_SETTING_${kind}: ${key}`);
}

function code(source: string): string {
  const blank = (text: string) => text.replace(/[^\r\n]/gu, " ");
  return source
    .replace(/(?:br|cr|r)(#+)?"[\s\S]*?"\1|(?:b|c)?"(?:\\.|[^"\\])*"/gu, blank)
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => {
      if (comment.slice(2).includes("/*")) fail("DEFAULT_UNPROVEN");
      return blank(comment);
    })
    .replace(/\/\/[^\r\n]*/gu, blank);
}

function required(source: string, pattern: RegExp, missing: Failure = "DEFAULT_UNPROVEN") {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const found = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (found.length !== 1) fail(found.length ? "DEFAULT_UNPROVEN" : missing);
  return found[0]!;
}

function integer(value: string): number | undefined {
  if (!/^\d[\d_]*$/u.test(value)) return undefined;
  const parsed = Number(value.replaceAll("_", ""));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function line(path: string, source: string, offset: number) {
  return { path, line: source.slice(0, offset).split("\n").length };
}

function inlineTest(source: string) {
  return /^[ \t]*#\[cfg\(test\)\][ \t]*\r?\n[ \t]*mod [A-Za-z_][A-Za-z_0-9]*[ \t]*\{/m.exec(source);
}

async function read(root: string, path: string) {
  try {
    return await NodeFSP.readFile(NodePath.join(root, path), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") fail("MISSING");
    throw error;
  }
}

export async function assertCodexMemorySettings(
  root: string,
  pins: Readonly<Record<string, number>>,
) {
  const extra = Object.keys(pins).find((key) => key !== KEY);
  if (extra) fail("DEFAULT_UNPROVEN", extra);
  if (!Object.hasOwn(pins, KEY)) fail("MISSING");
  const expected = pins[KEY]!;
  if (!Number.isSafeInteger(expected)) fail("DEFAULT_UNPROVEN");

  let base: string;
  try {
    base = await NodeFSP.realpath(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") fail("MISSING");
    throw error;
  }
  const [configText, defaultsText, loaderText, coreText, agentsText] = await Promise.all([
    read(base, CONFIG),
    read(base, DEFAULTS),
    read(base, LOADER),
    read(base, CORE),
    read(base, AGENTS),
  ]);

  const configSource = configText.split(/^[ \t]*#\[cfg\(test\)\]/m, 1)[0]!;
  // This pinned file has no block comments; reject them before stripping source trivia.
  if (configSource.includes("/*") || configSource.includes("*/")) fail("DEFAULT_UNPROVEN");
  const configCode = code(configSource);
  const configStruct = required(
    configCode,
    /^#\[derive\([^\r\n]*\bDeserialize\b[^\r\n]*\)\][ \t]*\r?\n#\[schemars\(deny_unknown_fields\)\][ \t]*\r?\npub struct ConfigToml \{([\s\S]*?)^[ \t]*\}[ \t]*$/m,
    "MISSING",
  );
  const codeField = required(
    configStruct[1]!,
    /^[ \t]*#\[serde\(default[ \t]*=[ \t]*\)[ \t]*\][ \t]*\r?\n[ \t]*pub project_doc_max_bytes: Option<usize>,[ \t]*$/m,
    "MISSING",
  );
  const configStructStart = configStruct.index!;
  const configSourceStruct = configSource.slice(
    configStructStart,
    configStructStart + configStruct[0].length,
  );
  const bodyStart = configStruct[0].indexOf("{") + 1;
  const configSourceBody = configSourceStruct.slice(bodyStart, configStruct[0].lastIndexOf("}"));
  const sourceField = required(
    configSourceBody,
    /^[ \t]*#\[serde\(default[ \t]*=[ \t]*"default_project_doc_max_bytes"[ \t]*\)\][ \t]*\r?\n[ \t]*pub project_doc_max_bytes: Option<usize>,[ \t]*$/m,
    "MISSING",
  );
  if (codeField.index !== sourceField.index) fail("MISSING");

  required(
    configCode,
    /^const fn default_project_doc_max_bytes\(\) -> Option<usize> \{[ \t]*\r?\n[ \t]*Some\(DEFAULT_PROJECT_DOC_MAX_BYTES\)[ \t]*\r?\n\}[ \t]*$/m,
  );
  const nativeDefault = required(
    configCode,
    /^[ \t]*pub const DEFAULT_PROJECT_DOC_MAX_BYTES: usize = ([^;\r\n]+);[ \t]*$/m,
  );
  const expression = /^(\d[\d_]*)(?:[ \t]*\*[ \t]*(\d[\d_]*))?$/u.exec(nativeDefault[1]!.trim());
  const left = expression ? integer(expression[1]!) : undefined;
  const right = expression?.[2] ? integer(expression[2]) : 1;
  const nativeValue = left === undefined || right === undefined ? undefined : left * right;
  if (nativeValue === undefined || !Number.isSafeInteger(nativeValue)) fail("DEFAULT_UNPROVEN");
  if (nativeValue !== expected) fail("DEFAULT_CHANGED");

  const section = /^[ \t]*\[/m.exec(defaultsText)?.index;
  const rootDefaults = section === undefined ? defaultsText : defaultsText.slice(0, section);
  if (rootDefaults.includes('"""') || rootDefaults.includes("'''")) fail("DEFAULT_UNPROVEN");
  const packaged = required(
    rootDefaults,
    /^[ \t]*project_doc_max_bytes[ \t]*=[ \t]*(\d[\d_]*)(?:[ \t]*#.*)?[ \t]*$/m,
    "MISSING",
  );
  const packagedValue = integer(packaged[1]!);
  if (packagedValue === undefined) fail("DEFAULT_UNPROVEN");
  if (packagedValue !== expected) fail("DEFAULT_CHANGED");

  const loaderCode = code(loaderText);
  const loader = required(
    loaderCode,
    /^pub async fn load_config_layers_state\([\s\S]{0,30000}?^\}[ \t]*$/m,
    "MISSING",
  );
  const loaderTests = inlineTest(loaderCode);
  if (loaderTests?.index !== undefined && loaderTests.index < loader.index!) fail("MISSING");
  const includeCode = required(
    loader[0],
    /^[ \t]*let raw_toml = include_str!\([ \t]*\);[ \t]*$/m,
    "MISSING",
  );
  const includeSource = required(
    loaderText,
    /^[ \t]*let raw_toml = include_str!\("\.\.\/\.\.\/defaults\.toml"\);[ \t]*$/m,
    "MISSING",
  );
  if (loader.index === undefined || includeCode.index !== includeSource.index - loader.index)
    fail("MISSING");
  if (
    !/toml::from_str\(raw_toml\)/u.test(loader[0]) ||
    !/ConfigLayerEntry::new_with_raw_toml\([\s\S]{0,500}?ConfigLayerSource::PackagedDefaults[ \t]*\{[^}]*\}\s*,\s*config\s*,\s*raw_toml\.to_owned\(\)/u.test(
      loader[0],
    )
  ) {
    fail("MISSING");
  }

  const coreCode = code(coreText);
  const config = required(
    coreCode,
    /^pub struct Config \{[\s\S]{0,30000}?^[ \t]*pub project_doc_max_bytes: usize,[ \t]*$/m,
    "MISSING",
  );
  if (
    !/^use codex_config::config_toml::DEFAULT_PROJECT_DOC_MAX_BYTES;[ \t]*$/m.test(coreCode) ||
    !/^pub\(crate\) const AGENTS_MD_MAX_BYTES: usize = DEFAULT_PROJECT_DOC_MAX_BYTES;[ \t]*$/m.test(
      coreCode,
    )
  ) {
    fail("DEFAULT_UNPROVEN");
  }
  const initializer = required(
    coreCode,
    /^[ \t]*model_providers,[ \t]*\r?\n[ \t]*project_doc_max_bytes: cfg\.project_doc_max_bytes\.unwrap_or\(([^)\r\n]+)\),[ \t]*\r?\n[ \t]*project_doc_fallback_filenames:/m,
  );
  const coreTests = inlineTest(coreCode);
  if (
    coreTests?.index !== undefined &&
    (coreTests.index < config.index! || coreTests.index < initializer.index!)
  ) {
    fail("MISSING");
  }
  if (
    config.index === undefined ||
    initializer.index === undefined ||
    initializer.index < config.index
  )
    fail("DEFAULT_UNPROVEN");
  const fallback = initializer[1]!.trim();
  if (/^\d/u.test(fallback)) {
    const value = integer(fallback);
    if (value === undefined) fail("DEFAULT_UNPROVEN");
    if (value !== expected) fail("DEFAULT_CHANGED");
  } else if (fallback !== "AGENTS_MD_MAX_BYTES" && fallback !== "DEFAULT_PROJECT_DOC_MAX_BYTES") {
    fail("DEFAULT_UNPROVEN");
  }

  const agentsCode = code(agentsText).split(/^[ \t]*#\[cfg\(test\)\]/m, 1)[0]!;
  const load = required(
    agentsCode,
    /^pub\(crate\) async fn load_project_instructions\([\s\S]{0,8000}?^\}[ \t]*$/m,
    "MISSING",
  );
  const remaining = required(
    load[0],
    /^[ \t]*let mut remaining = config\.project_doc_max_bytes;[ \t]*$/m,
    "MISSING",
  );
  const readCall = required(
    load[0],
    /match read_agents_md\([\s\S]{0,500}?\n[ \t]*remaining,[\s\S]{0,100}?\n[ \t]*sandbox\.as_ref\(\),/m,
    "MISSING",
  );
  const aggregate = required(
    load[0],
    /remaining = remaining\.saturating_sub\(entry\.contents\.len\(\)\);/m,
    "MISSING",
  );
  const reader = required(
    agentsCode,
    /^async fn read_agents_md\([\s\S]{0,6000}?^\}[ \t]*$/m,
    "MISSING",
  );
  if (
    !/max_total: usize,/u.test(reader[0]) ||
    !/let mut remaining: u64 = max_total as u64;/u.test(reader[0])
  )
    fail("DEFAULT_UNPROVEN");
  const fileRead = required(
    reader[0],
    /fs\.read_file\(&p, ReadFileOptions::default\(\), sandbox\)\.await/m,
    "MISSING",
  );
  const truncate = required(
    reader[0],
    /if size > remaining \{[\s\S]{0,120}?data\.truncate\(remaining as usize\);[\s\S]{0,20}?\}/m,
    "MISSING",
  );
  const reads = [
    line(CORE, coreCode, initializer.index!),
    line(AGENTS, agentsCode, load.index! + remaining.index!),
    line(AGENTS, agentsCode, load.index! + readCall.index!),
    line(AGENTS, agentsCode, load.index! + aggregate.index!),
    line(AGENTS, agentsCode, reader.index! + fileRead.index!),
    line(AGENTS, agentsCode, reader.index! + truncate.index!),
  ].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

  const sources = [
    [CONFIG, configText],
    [DEFAULTS, defaultsText],
    [LOADER, loaderText],
    [CORE, coreText],
    [AGENTS, agentsText],
  ] as const;
  return {
    schemaVersion: 1,
    pins: { [KEY]: expected },
    settings: [
      {
        key: KEY,
        value: expected,
        fieldPath: `${CONFIG}::ConfigToml.${KEY}`,
        defaultPath: `${CONFIG}::default_${KEY} -> DEFAULT_${KEY.toUpperCase()}`,
        productionReads: reads,
      },
    ],
    sources: sources
      .map(([path, source]) => ({ path, sha256: sha256(source) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    packagedDefaults: { path: DEFAULTS, loaderPath: LOADER, sha256: sha256(defaultsText) },
  };
}
