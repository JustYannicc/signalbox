// @effect-diagnostics globalConsole:off globalFetch:off - runs on the user's computer under plain node, not in the cloud.
/**
 * The setup a person runs on their own computer to put its Claude Code and
 * Codex on their pool, in one pasted command:
 *
 *   curl -fsSL https://app.signalbox.run/api/local-keys/setup | node - sbk_…
 *
 * `localKeyRoutes.ts` serves `localSetup` as that script. It checks the key
 * with the ModelGateway first and writes nothing if the pool doesn't answer.
 * Then it configures each harness the way its docs describe, with the key in
 * the harness's own config so apps launched from the Dock (no shell
 * environment) get it too, and without touching either harness's login:
 *
 * - Claude Code: `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in the `env`
 *   of `settings.json`. The token outranks a claude.ai login, which stays
 *   signed in underneath.
 * - Codex (CLI and desktop app): OpenAI's gateway pattern, a `signalbox`
 *   model provider in `config.toml` with `requires_openai_auth = true` and the
 *   key in `http_headers`, chosen as `model_provider`. Codex keeps its own
 *   ChatGPT sign-in in `auth.json`, which setup never opens; the gateway takes
 *   the key from its header and drops the ChatGPT credentials.
 *
 * It honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. What it replaced is kept
 * beside each config, and `--undo` puts it back.
 *
 * It reads both configs and works out every change before writing any, so a
 * config it can't take leaves the computer as it was.
 *
 * It is served as its source text, so it reaches nothing outside its own body
 * and needs only node 22. `setupScript` passes in what the cloud knows.
 */
export interface LocalSetupConfig {
  /** Where this script is served, for the undo command it prints. */
  readonly setupUrl: string;
  /** The ModelGateway's Anthropic and OpenAI endpoints (`MODEL_GATEWAY_PATHS`). */
  readonly anthropicUrl: string;
  readonly openaiUrl: string;
  /** What every local key starts with. */
  readonly keyPrefix: string;
  /** The header the ModelGateway reads a key from (`LOCAL_KEY_HEADER`). */
  readonly keyHeader: string;
}

export async function localSetup(
  config: LocalSetupConfig,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const codexDir = env.CODEX_HOME || path.join(home, ".codex");
  const PREVIOUS_FILE = "signalbox-previous.json";
  const BEGIN = "# >>> signalbox: written by Signalbox setup; remove with its --undo";
  const END = "# <<< signalbox";
  const CLAUDE_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"];
  const shown = (file: string) =>
    home && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  const readJson = (file: string): Record<string, unknown> | null => {
    const text = read(file);
    if (text === null || text.trim() === "") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${shown(file)} isn't valid JSON. Fix it and run this again.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${shown(file)} isn't a JSON object. Fix it and run this again.`);
    }
    return parsed as Record<string, unknown>;
  };
  /** A file's new contents, or null to remove it. */
  type Change = readonly [file: string, text: string | null];
  const apply = (changes: ReadonlyArray<Change>) => {
    for (const [file, text] of changes) {
      if (text === null) {
        fs.rmSync(file, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  };

  /** Root-table lines of a TOML file end at its first table header. */
  const rootEnd = (lines: ReadonlyArray<string>) => {
    const index = lines.findIndex((line) => /^\s*\[/.test(line));
    return index === -1 ? lines.length : index;
  };
  const withoutBlock = (text: string) => {
    const lines = text.split("\n");
    const start = lines.indexOf(BEGIN);
    const end = lines.indexOf(END, start);
    if (start === -1 || end === -1) return text;
    const kept = [...lines.slice(0, start), ...lines.slice(end + 1)];
    while (kept.length > 1 && kept[kept.length - 1] === "" && kept[kept.length - 2] === "") {
      kept.pop();
    }
    return kept.join("\n");
  };
  const isProviderLine = (line: string) => /^\s*model_provider\s*=/.test(line);

  // Claude Code: settings.json, keeping everything it doesn't own.
  const claudeSettings = path.join(claudeDir, "settings.json");
  const claudePrevious = path.join(claudeDir, PREVIOUS_FILE);
  const setUpClaude = (key: string): ReadonlyArray<Change> => {
    const settings = readJson(claudeSettings) ?? {};
    const envBlock = (settings.env ?? {}) as Record<string, unknown>;
    // A second run keeps what the first one replaced.
    const previous: ReadonlyArray<Change> = fs.existsSync(claudePrevious)
      ? []
      : [
          [
            claudePrevious,
            json({
              env: Object.fromEntries(CLAUDE_ENV.map((name) => [name, envBlock[name] ?? null])),
            }),
          ],
        ];
    // The token outranks an API key, an `apiKeyHelper` and a claude.ai login,
    // so all of those stay as they are.
    const next = {
      ...settings,
      env: { ...envBlock, ANTHROPIC_BASE_URL: config.anthropicUrl, ANTHROPIC_AUTH_TOKEN: key },
    };
    return [...previous, [claudeSettings, json(next)]];
  };
  const undoClaude = (): ReadonlyArray<Change> => {
    const settings = readJson(claudeSettings);
    const cleanup: ReadonlyArray<Change> = [[claudePrevious, null]];
    if (settings === null) return cleanup;
    // Without the record of what it replaced, setup's own values still go.
    const previous = readJson(claudePrevious) ?? {
      env: Object.fromEntries(CLAUDE_ENV.map((name) => [name, null])),
    };
    const restored: Record<string, unknown> = { ...settings };
    const envBlock = { ...((settings.env ?? {}) as Record<string, unknown>) };
    const before = (previous.env ?? {}) as Record<string, unknown>;
    for (const name of CLAUDE_ENV) {
      if (before[name] === null || before[name] === undefined) delete envBlock[name];
      else envBlock[name] = before[name];
    }
    if (Object.keys(envBlock).length === 0) delete restored.env;
    else restored.env = envBlock;
    // Setup made the file if it had none; it goes again.
    const text = Object.keys(restored).length === 0 ? null : json(restored);
    return [[claudeSettings, text], ...cleanup];
  };

  // Codex: config.toml, edited as text so its comments and layout stay.
  const codexConfig = path.join(codexDir, "config.toml");
  const codexPrevious = path.join(codexDir, PREVIOUS_FILE);
  const setUpCodex = (key: string): ReadonlyArray<Change> => {
    const lines = withoutBlock(read(codexConfig) ?? "").split("\n");
    if (lines.some((line) => /^\s*\[?\s*model_providers\.signalbox\b/.test(line))) {
      throw new Error(`${shown(codexConfig)} already has a "signalbox" model provider.`);
    }
    const root = rootEnd(lines);
    const index = lines.slice(0, root).findIndex(isProviderLine);
    const previous: ReadonlyArray<Change> = fs.existsSync(codexPrevious)
      ? []
      : [[codexPrevious, json({ modelProvider: index === -1 ? null : lines[index] })]];
    const choice = 'model_provider = "signalbox"';
    if (index === -1) lines.unshift(choice);
    else lines[index] = choice;
    const body = lines.join("\n").replace(/\n*$/, "\n");
    const block = [
      BEGIN,
      "[model_providers.signalbox]",
      'name = "Signalbox"',
      `base_url = ${JSON.stringify(config.openaiUrl)}`,
      'wire_api = "responses"',
      // Codex keeps sending its own sign-in; the gateway authenticates the key header.
      "requires_openai_auth = true",
      "supports_websockets = false",
      `http_headers = { ${JSON.stringify(config.keyHeader)} = ${JSON.stringify(key)} }`,
      END,
      "",
    ].join("\n");
    return [...previous, [codexConfig, `${body.trim() === "" ? "" : `${body}\n`}${block}`]];
  };
  const undoCodex = (): ReadonlyArray<Change> => {
    const cleanup: ReadonlyArray<Change> = [[codexPrevious, null]];
    const text = read(codexConfig);
    if (text === null) return cleanup;
    const before = readJson(codexPrevious)?.modelProvider;
    const lines = withoutBlock(text).split("\n");
    const index = lines
      .slice(0, rootEnd(lines))
      .findIndex((line) => isProviderLine(line) && line.includes('"signalbox"'));
    if (index !== -1) {
      if (typeof before === "string") lines[index] = before;
      else lines.splice(index, 1);
    }
    const restored = lines.join("\n");
    return [[codexConfig, restored.trim() === "" ? null : restored], ...cleanup];
  };

  try {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- runs under plain node on the user's computer.
    if (process.platform === "win32") {
      console.error("This setup runs on macOS and Linux. Windows isn't supported yet.");
      return 1;
    }
    if (args[0] === "--undo") {
      apply([...undoClaude(), ...undoCodex()]);
      console.log("Claude Code and Codex are back on their own settings.");
      return 0;
    }
    const key = args[0] ?? "";
    if (!key.startsWith(config.keyPrefix)) {
      console.error("Pass the Signalbox key from Settings › Pools after `node -`.");
      return 1;
    }
    const check = await fetch(`${config.anthropicUrl}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
    }).catch(() => null);
    if (check === null || !check.ok) {
      const body = check === null ? null : await check.json().catch(() => null);
      const message = (body as { error?: { message?: string } } | null)?.error?.message;
      const reason =
        message ?? (check === null ? "Signalbox is unreachable." : `HTTP ${check.status}`);
      console.error(`Your pool didn't answer, so nothing was changed: ${reason}`);
      return 1;
    }
    // Both configs are read and checked before anything is written.
    apply([...setUpClaude(key), ...setUpCodex(key)]);
    console.log("Your Signalbox pool answered. Claude Code and Codex now run on it:");
    console.log(`  Claude Code  ${shown(claudeSettings)}`);
    console.log(`  Codex        ${shown(codexConfig)}`);
    console.log(`Undo: curl -fsSL ${config.setupUrl} | node - --undo`);
    return 0;
  } catch (error) {
    console.error(`Setup stopped: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * The script `localSetup` is served as: its source, called with this cloud's
 * URLs. The Worker's bundler keeps function names by wrapping them in
 * `__name(...)`, which the source text then calls, so the script defines it.
 */
export const setupScript = (config: LocalSetupConfig) =>
  [
    "// Signalbox: puts this computer's Claude Code and Codex on your pool.",
    "var __name = (target) => target;",
    `(${localSetup.toString()})(${JSON.stringify(config)}, process.argv.slice(2), process.env)`,
    "  .then((code) => process.exit(code));",
    "",
  ].join("\n");
