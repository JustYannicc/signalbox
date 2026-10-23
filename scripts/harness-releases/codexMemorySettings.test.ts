import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CODEX_MEMORY_CONFIG } from "@t3tools/contracts/harnessMemorySettings";
import { assertCodexMemorySettings } from "./codexMemorySettings.ts";

const roots: string[] = [];
const key = "project_doc_max_bytes";
const projectValue = CODEX_MEMORY_CONFIG.project_doc_max_bytes;

const validSources = {
  "codex-rs/config/src/config_toml.rs": `
pub const DEFAULT_PROJECT_DOC_MAX_BYTES: usize = 32 * 1024;

const fn default_project_doc_max_bytes() -> Option<usize> {
    Some(DEFAULT_PROJECT_DOC_MAX_BYTES)
}
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ConfigToml {
    #[serde(default = "default_project_doc_max_bytes")]
    pub project_doc_max_bytes: Option<usize>,
}
`,
  "codex-rs/config/defaults.toml": `project_doc_max_bytes = ${projectValue}

[history]
persistence = "save-all"
`,
  "codex-rs/config/src/loader/mod.rs": `
pub async fn load_config_layers_state() {
    let raw_toml = include_str!("../../defaults.toml");
    let config = toml::from_str(raw_toml).map_err(|_| ())?;
    ConfigLayerEntry::new_with_raw_toml(
        ConfigLayerSource::PackagedDefaults { file },
        config,
        raw_toml.to_owned(),
    );
}
`,
  "codex-rs/core/src/config/mod.rs": `
use codex_config::config_toml::DEFAULT_PROJECT_DOC_MAX_BYTES;
pub(crate) const AGENTS_MD_MAX_BYTES: usize = DEFAULT_PROJECT_DOC_MAX_BYTES;
pub struct Config {
    pub project_doc_max_bytes: usize,
}
fn build(cfg: ConfigToml) {
    let _config = Config {
        model_providers,
        project_doc_max_bytes: cfg.project_doc_max_bytes.unwrap_or(AGENTS_MD_MAX_BYTES),
        project_doc_fallback_filenames: Vec::new(),
    };
}
`,
  "codex-rs/core/src/agents_md.rs": `
pub(crate) async fn load_project_instructions(config: &Config) {
    let mut remaining = config.project_doc_max_bytes;
    match read_agents_md(
        config,
        remaining,
        sandbox.as_ref(),
    ) {
        Ok(Some(entries)) => {
            for entry in entries {
                remaining = remaining.saturating_sub(entry.contents.len());
            }
        }
        _ => {}
    }
}
async fn read_agents_md(max_total: usize, fs: &FileSystem) {
    if max_total == 0 {
        return;
    }
    let mut remaining: u64 = max_total as u64;
    let mut data = fs.read_file(&p, ReadFileOptions::default(), sandbox).await;
    let size = data.len() as u64;
    if size > remaining {
        data.truncate(remaining as usize);
    }
}
`,
  "codex-rs/core/src/agents_md_manager.rs": `
pub(crate) async fn refresh(&self, config: &Config, environments: &TurnEnvironmentSnapshot) {
    let _loaded = load_project_instructions(config, None, environments).await?;
}
`,
} as const;

type SourcePath = keyof typeof validSources;

async function fixture(overrides: Partial<Record<SourcePath, string>> = {}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-memory-settings-"));
  roots.push(root);
  for (const [path, source] of Object.entries({ ...validSources, ...overrides })) {
    const target = NodePath.join(root, path);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, source);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Codex release memory setting", () => {
  it("rejects unsupported nested comments around loader wiring", async () => {
    const loader = "codex-rs/config/src/loader/mod.rs";
    const root = await fixture({
      [loader]: `pub async fn load_config_layers_state() {
  /* outer /* inner */
    let raw_toml = include_str!("../../defaults.toml");
    let config = toml::from_str(raw_toml).map_err(|_| ())?;
    ConfigLayerEntry::new_with_raw_toml(
        ConfigLayerSource::PackagedDefaults { file },
        config,
        raw_toml.to_owned(),
    );
  */
  Default::default()
}
`,
    });
    await expect(assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)).rejects.toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${key}`,
    );
  });

  it("proves the pinned default reaches the production project document reader", async () => {
    const evidence = await assertCodexMemorySettings(await fixture(), CODEX_MEMORY_CONFIG);

    expect(evidence.settings).toHaveLength(1);
    expect(evidence.settings[0]).toMatchObject({ key, value: projectValue });
    expect(evidence.packagedDefaults).toMatchObject({
      path: "codex-rs/config/defaults.toml",
      loaderPath: "codex-rs/config/src/loader/mod.rs",
    });
    expect(evidence.settings[0]!.productionReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "codex-rs/core/src/agents_md.rs" }),
        expect.objectContaining({ path: "codex-rs/core/src/config/mod.rs" }),
      ]),
    );
  });

  it("rejects a missing or renamed ConfigToml key despite comment, string, and test decoys", async () => {
    const source = validSources["codex-rs/config/src/config_toml.rs"].replace(
      "pub project_doc_max_bytes: Option<usize>,",
      "pub renamed_project_doc_max_bytes: Option<usize>,",
    ).concat(`
// pub project_doc_max_bytes: Option<usize>,
const DECOY: &str = r#"pub struct ConfigToml {
    #[serde(default = "default_project_doc_max_bytes")]
    pub project_doc_max_bytes: Option<usize>,
}"#;
#[cfg(test)]
mod tests { pub struct ConfigToml { pub project_doc_max_bytes: Option<usize> } }
`);

    await expect(
      assertCodexMemorySettings(
        await fixture({ "codex-rs/config/src/config_toml.rs": source }),
        CODEX_MEMORY_CONFIG,
      ),
    ).rejects.toThrow(`RELEASE_MEMORY_SETTING_MISSING: ${key}`);
  });

  it("fails closed on a nested block comment that contains a fake ConfigToml field", async () => {
    const source = validSources["codex-rs/config/src/config_toml.rs"].replace(
      "pub project_doc_max_bytes: Option<usize>,",
      "pub renamed_project_doc_max_bytes: Option<usize>,",
    );
    const fakeConfigToml = `#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ConfigToml {
    #[serde(default = "default_project_doc_max_bytes")]
    pub project_doc_max_bytes: Option<usize>,
}`;

    await expect(
      assertCodexMemorySettings(
        await fixture({
          "codex-rs/config/src/config_toml.rs": `/* outer /* inner */\n${fakeConfigToml}\n*/\n${source}`,
        }),
        CODEX_MEMORY_CONFIG,
      ),
    ).rejects.toThrow(`RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${key}`);
  });

  it("does not take a pinned field from a later struct", async () => {
    const source = validSources["codex-rs/config/src/config_toml.rs"].replace(
      "    pub project_doc_max_bytes: Option<usize>,\n}",
      `    pub renamed_project_doc_max_bytes: Option<usize>,
}
pub struct Decoy {
    #[serde(default = "default_project_doc_max_bytes")]
    pub project_doc_max_bytes: Option<usize>,
}`,
    );

    await expect(
      assertCodexMemorySettings(
        await fixture({ "codex-rs/config/src/config_toml.rs": source }),
        CODEX_MEMORY_CONFIG,
      ),
    ).rejects.toThrow(`RELEASE_MEMORY_SETTING_MISSING: ${key}`);
  });

  it("rejects a changed Rust default", async () => {
    const source = validSources["codex-rs/config/src/config_toml.rs"].replace(
      "32 * 1024",
      "64 * 1024",
    );

    await expect(
      assertCodexMemorySettings(
        await fixture({ "codex-rs/config/src/config_toml.rs": source }),
        CODEX_MEMORY_CONFIG,
      ),
    ).rejects.toThrow(`RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`);
  });

  it("fails closed when the default function appears only in a comment, string, or test module", async () => {
    const source = validSources["codex-rs/config/src/config_toml.rs"]
      .replace(
        `const fn default_project_doc_max_bytes() -> Option<usize> {
    Some(DEFAULT_PROJECT_DOC_MAX_BYTES)
}`,
        `// const fn default_project_doc_max_bytes() -> Option<usize> { Some(DEFAULT_PROJECT_DOC_MAX_BYTES) }
const DECOY: &str = r#"const fn default_project_doc_max_bytes() -> Option<usize> {
    Some(DEFAULT_PROJECT_DOC_MAX_BYTES)
}"#;`,
      )
      .concat(
        `
#[cfg(test)] mod tests { const fn default_project_doc_max_bytes() -> Option<usize> { Some(DEFAULT_PROJECT_DOC_MAX_BYTES) } }
`,
      );

    await expect(
      assertCodexMemorySettings(
        await fixture({ "codex-rs/config/src/config_toml.rs": source }),
        CODEX_MEMORY_CONFIG,
      ),
    ).rejects.toThrow(`RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${key}`);
  });

  it("detects a changed packaged default", async () => {
    const defaults = `project_doc_max_bytes = ${projectValue + 1}\n`;

    await expect(
      assertCodexMemorySettings(
        await fixture({ "codex-rs/config/defaults.toml": defaults }),
        CODEX_MEMORY_CONFIG,
      ),
    ).rejects.toThrow(`RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`);
  });

  it("detects a changed effective Config fallback", async () => {
    const source = validSources["codex-rs/core/src/config/mod.rs"].replace(
      "unwrap_or(AGENTS_MD_MAX_BYTES)",
      `unwrap_or(${projectValue + 1})`,
    );

    await expect(
      assertCodexMemorySettings(
        await fixture({ "codex-rs/core/src/config/mod.rs": source }),
        CODEX_MEMORY_CONFIG,
      ),
    ).rejects.toThrow(`RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`);
  });

  it("does not accept comment, string, or test-only loader and reader decoys", async () => {
    const loader = `// pub async fn load_config_layers_state() { let raw_toml = include_str!("../../defaults.toml"); }
const DECOY: &str = r#"pub async fn load_config_layers_state() {
    let raw_toml = include_str!("../../defaults.toml");
}"#;
#[cfg(test)] mod tests { pub async fn load_config_layers_state() { let _ = include_str!("../../defaults.toml"); } }
`;
    const agents = `// pub(crate) async fn load_project_instructions(config: &Config) {}
const DECOY: &str = r#"pub(crate) async fn load_project_instructions(config: &Config) {
    let mut remaining = config.project_doc_max_bytes;
    read_agents_md(config, remaining, sandbox.as_ref());
}"#;
#[cfg(test)] mod tests { async fn read_agents_md() { fs.read_file(&p, ReadFileOptions::default(), sandbox).await; } }
`;

    await expect(
      assertCodexMemorySettings(
        await fixture({
          "codex-rs/config/src/loader/mod.rs": loader,
          "codex-rs/core/src/agents_md.rs": agents,
        }),
        CODEX_MEMORY_CONFIG,
      ),
    ).rejects.toThrow(`RELEASE_MEMORY_SETTING_MISSING: ${key}`);
  });

  it("rejects pins outside the retained project document budget", async () => {
    await expect(
      assertCodexMemorySettings(await fixture(), { ...CODEX_MEMORY_CONFIG, "memories.other": 1 }),
    ).rejects.toThrow("RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: memories.other");
  });
});
