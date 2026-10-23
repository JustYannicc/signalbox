import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CODEX_MEMORY_CONFIG } from "@t3tools/contracts/harnessMemorySettings";
import { assertCodexMemorySettings } from "./codexMemorySettings.ts";
import { constantValue, tokenizeRust } from "./codexMemorySource.ts";

const roots: string[] = [];
const memorySettings = Object.entries(CODEX_MEMORY_CONFIG).filter(([key]) =>
  key.startsWith("memories."),
);
const firstSortedMemoryKey = memorySettings.map(([key]) => key).sort()[0]!;

async function fixture(
  options: {
    omit?: string;
    rename?: string;
    renameAll?: boolean;
    serdeRename?: string;
    serdeField?: string;
    serdeFieldOverride?: string;
    serdeMemoryStructOverride?: string;
    serdeConfigGroupOverride?: string;
    removeMemoryDeserialize?: boolean;
    changedConstant?: string;
    packaged?: string;
    schemaDefault?: number;
    consumer?: "comment-string" | "write" | "shadow" | "nested-shadow";
    clampDecoy?: boolean;
  } = {},
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-memory-settings-"));
  roots.push(root);
  const write = async (path: string, content: string) => {
    const target = NodePath.join(root, path);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, content);
  };
  const projectValue = CODEX_MEMORY_CONFIG.project_doc_max_bytes;
  const selectedFields = memorySettings.map(([key]) => key.slice("memories.".length));
  const fieldForSource = (field: string) => (field === options.rename ? `${field}_renamed` : field);
  const memoryDeclarations = memorySettings
    .filter(([key]) => key !== options.omit)
    .map(([key, value]) => {
      const field = key.slice("memories.".length);
      const sourceField = fieldForSource(field);
      const constant = `DEFAULT_MEMORIES_${field.toUpperCase()}`;
      const type = field.endsWith("_days") ? "i64" : "usize";
      const defaultValue = key === options.changedConstant ? value + 1 : value;
      return { key, field, sourceField, constant, type, defaultValue };
    });
  const consts = memoryDeclarations
    .map(({ constant, type, defaultValue }) => `pub const ${constant}: ${type} = ${defaultValue};`)
    .join("\n");
  const tomlFields = memoryDeclarations
    .map(
      ({ field, sourceField, type }) =>
        `${field === options.serdeRename ? `#[serde(rename = "${field}_renamed")]` : ""}${field === options.serdeField ? `\n#[serde(${options.serdeFieldOverride})]` : ""}\npub ${sourceField}: Option<${type}>,`,
    )
    .join("\n");
  const configFields = memoryDeclarations
    .map(({ sourceField, type }) => `pub ${sourceField}: ${type},`)
    .join("\n");
  const defaults = memoryDeclarations
    .map(({ sourceField, constant }) => `${sourceField}: ${constant},`)
    .join("\n");
  const conversions = memoryDeclarations
    .map(
      ({ sourceField }) =>
        `${sourceField}: toml.${sourceField}.unwrap_or(defaults.${sourceField}).clamp(0, 1000),`,
    )
    .join("\n");
  const consumers =
    options.consumer === "comment-string"
      ? `// config.memories.${selectedFields[0]}
      let _comment: &str = "config.memories.${selectedFields[0]}";`
      : options.consumer === "write"
        ? `config.memories.${selectedFields[0]} = 3;`
        : options.consumer === "shadow"
          ? `let config: FakeConfig = fake_config(); let _shadow = config.memories.${selectedFields[0]};`
          : options.consumer === "nested-shadow"
            ? `fn fake(config: &FakeConfig) { let _shadow = config.memories.${selectedFields[0]}; }`
            : selectedFields
                .map((field) => `let _${field}: i64 = config.memories.${field};`)
                .join("\n");
  const packaged = options.packaged ?? `project_doc_max_bytes = ${projectValue}`;
  const packagedSchemaDefault = options.schemaDefault ?? projectValue;

  await write(
    "codex-rs/config/src/config_toml.rs",
    `
pub const DEFAULT_PROJECT_DOC_MAX_BYTES: usize = ${projectValue};
const fn default_project_doc_max_bytes() -> Option<usize> { Some(DEFAULT_PROJECT_DOC_MAX_BYTES) }
#[derive(Clone, Debug, Default, Deserialize)]
#[allow(non_camel_case_types)]
pub struct ConfigToml {
  #[serde(default = "default_project_doc_max_bytes")]
  pub project_doc_max_bytes: Option<usize>,
  ${options.serdeConfigGroupOverride ? `#[serde(${options.serdeConfigGroupOverride})]` : ""}
  pub memories: Option<MemoriesToml>,
}
`,
  );
  await write(
    "codex-rs/config/src/types.rs",
    `
#[derive(${options.removeMemoryDeserialize ? "Default" : "Deserialize, Default"})]
  ${options.renameAll ? '#[serde(rename_all = "camelCase")]' : ""}
  ${options.serdeMemoryStructOverride ? `#[serde(${options.serdeMemoryStructOverride})]` : ""}
pub struct MemoriesToml { ${tomlFields} }
pub struct MemoriesConfig { ${configFields} }
${consts}
${options.clampDecoy ? `fn decoy(toml: MemoriesToml, defaults: MemoriesConfig) { let _ = toml.${selectedFields[0]}.unwrap_or(defaults.${selectedFields[0]}).clamp(1, 2); }` : ""}
impl Default for MemoriesConfig {
  fn default() -> Self { Self { ${defaults} } }
}
impl From<MemoriesToml> for MemoriesConfig {
  fn from(toml: MemoriesToml) -> Self {
    let defaults = Self::default();
    Self { ${conversions} }
  }
}
`,
  );
  await write(
    "codex-rs/config/src/loader/mod.rs",
    `let raw_toml = include_str!("../../defaults.toml");`,
  );
  await write("codex-rs/config/defaults.toml", `${packaged}\n`);
  await write(
    "codex-rs/core/src/config/mod.rs",
    `
pub struct Config { pub project_doc_max_bytes: usize, pub memories: MemoriesConfig }
fn from_toml(cfg: ConfigToml) {
  let memories_config: MemoriesConfig = cfg.memories.clone().unwrap_or_default().into();
  let config = Config {
    project_doc_max_bytes: cfg.project_doc_max_bytes.unwrap_or(AGENTS_MD_MAX_BYTES),
    memories: memories_config,
  };
}
`,
  );
  await write(
    "codex-rs/core/src/agents_md.rs",
    `fn load(config: &Config) { let _limit = config.project_doc_max_bytes; }`,
  );
  await write("codex-rs/memories/write/src/phase1.rs", `fn run(config: &Config) { ${consumers} }`);
  await write(
    "codex-rs/core/config.schema.json",
    JSON.stringify({
      properties: {
        project_doc_max_bytes: { default: packagedSchemaDefault },
        memories: { allOf: [{ $ref: "#/definitions/MemoriesToml" }] },
      },
      definitions: {
        MemoriesToml: {
          properties: Object.fromEntries(
            selectedFields.map((field) => [field, { type: "integer" }]),
          ),
        },
      },
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Codex release memory settings", () => {
  it("proves native defaults, packaged defaults, and production reads from source", async () => {
    const root = await fixture();
    const evidence = await assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG);

    expect(evidence.settings).toHaveLength(Object.keys(CODEX_MEMORY_CONFIG).length);
    expect(evidence.settings.find(({ key }) => key === "project_doc_max_bytes")?.value).toBe(32768);
    expect(
      evidence.settings.find(({ key }) => key === memorySettings[0]![0])?.productionReads,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "codex-rs/memories/write/src/phase1.rs" }),
      ]),
    );
    expect(evidence.sources.map(({ path }) => path)).toContain("codex-rs/core/config.schema.json");
  });

  it("fails closed when an upstream rename removes a pinned field", async () => {
    const key = memorySettings[0]![0];
    const root = await fixture({ rename: key.slice("memories.".length) });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_MISSING: ${key}`,
    );
  });

  it("does not assume the Rust identifier is the TOML key after struct serde renaming", async () => {
    const root = await fixture({ renameAll: true });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${firstSortedMemoryKey}`,
    );
  });

  it("rejects a serde rename on the pinned field", async () => {
    const key = memorySettings[0]![0];
    const root = await fixture({ serdeRename: key.slice("memories.".length) });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${key}`,
    );
  });

  it("rejects a custom missing-field default on a pinned memory setting", async () => {
    const key = memorySettings[0]![0];
    const root = await fixture({
      serdeField: key.slice("memories.".length),
      serdeFieldOverride: 'default = "custom_default"',
    });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${key}`,
    );
  });

  it("rejects a custom missing-field default on MemoriesToml", async () => {
    const root = await fixture({ serdeMemoryStructOverride: 'default = "custom_default"' });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${firstSortedMemoryKey}`,
    );
  });

  it("rejects a custom deserializer on the ConfigToml memories group", async () => {
    const root = await fixture({
      serdeConfigGroupOverride: 'deserialize_with = "custom_memories"',
    });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${firstSortedMemoryKey}`,
    );
  });

  it("rejects loss of the MemoriesToml Deserialize derive", async () => {
    const root = await fixture({ removeMemoryDeserialize: true });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${firstSortedMemoryKey}`,
    );
  });

  it("does not count a test-only field reference as a production read", async () => {
    const root = await fixture();
    const path = NodePath.join(root, "codex-rs/memories/write/src/phase1.rs");
    const testReads = memorySettings
      .map(([setting]) => `let _ = config.memories.${setting.slice("memories.".length)};`)
      .join("\n");
    await NodeFSP.writeFile(
      path,
      `#[cfg(test)] mod tests { fn fake(config: &Config) { ${testReads} } }`,
    );

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_MISSING: ${firstSortedMemoryKey}`,
    );
  });

  it("ignores comments and strings that resemble production reads", async () => {
    const root = await fixture({ consumer: "comment-string" });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_MISSING: ${firstSortedMemoryKey}`,
    );
  });

  it("does not count an assignment as a production read", async () => {
    const root = await fixture({ consumer: "write" });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_MISSING: ${firstSortedMemoryKey}`,
    );
  });

  it("does not count a shadowed config variable as a production read", async () => {
    const root = await fixture({ consumer: "shadow" });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_MISSING: ${firstSortedMemoryKey}`,
    );
  });

  it("does not count a same-named nested function parameter as a production read", async () => {
    const root = await fixture({ consumer: "nested-shadow" });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_MISSING: ${firstSortedMemoryKey}`,
    );
  });

  it("rejects a changed Rust fallback default", async () => {
    const key = memorySettings[0]![0];
    const root = await fixture({ changedConstant: key });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`,
    );
  });

  it("rejects a changed packaged memory default even when Rust fallback is unchanged", async () => {
    const [key, value] = memorySettings[0]!;
    const field = key.slice("memories.".length);
    const root = await fixture({
      packaged: `project_doc_max_bytes = ${CODEX_MEMORY_CONFIG.project_doc_max_bytes}\n\n[memories]\n${field} = ${value + 1}`,
    });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`,
    );
  });

  it("reads quoted keys inside a multiline inline memory table", async () => {
    const [key, value] = memorySettings[0]!;
    const field = key.slice("memories.".length);
    const root = await fixture({ packaged: `memories = {\n  "${field}" = ${value + 1},\n}` });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`,
    );
  });

  it("reads quoted section and field keys", async () => {
    const [key, value] = memorySettings[0]!;
    const field = key.slice("memories.".length);
    const root = await fixture({ packaged: `["memories"]\n"${field}" = ${value + 1}` });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`,
    );
  });

  it("uses the conversion implementation when proving a clamped default", async () => {
    const root = await fixture({ clampDecoy: true });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).resolves.toMatchObject({
      schemaVersion: 1,
    });
  });

  it("rejects a changed static schema default", async () => {
    const root = await fixture({ schemaDefault: CODEX_MEMORY_CONFIG.project_doc_max_bytes + 1 });

    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      "RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: project_doc_max_bytes",
    );
  });

  it("fails closed on cyclic Rust default constants", () => {
    const tokens = tokenizeRust("const FIRST: usize = SECOND; const SECOND: usize = FIRST;");

    expect(constantValue(tokens, "FIRST")).toBeUndefined();
  });
});
