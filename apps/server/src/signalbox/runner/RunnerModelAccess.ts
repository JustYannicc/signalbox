import { MODEL_GATEWAY_PATHS } from "@signalbox/runner-protocol/RunnerProtocol";
import type { ClaudeSettings, CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * How a machine's harnesses reach their models with no provider key on the
 * machine: through the ModelGateway, presenting the current turn's model
 * token. Claude Code gets the gateway as `ANTHROPIC_BASE_URL` and the token
 * from an `apiKeyHelper`; Codex gets a custom provider in its `config.toml`
 * whose `auth.command` reads the token. Both read it from one file the Runner rewrites at each
 * turn start, and both fetch it again when the gateway turns down the last
 * turn's token, so a long-lived session follows the turns.
 *
 * Each thread's machine has its own home, Claude config and Codex home, and
 * the harnesses see only a short allowlist of the host's environment, so a
 * login or key the host has (`~/.codex/auth.json`, the keychain,
 * `ANTHROPIC_API_KEY`) never reaches them. The token is readable by the
 * agent's shell by design: outside its turn, thread and provider it is useless.
 */

export interface MachineLayout {
  /** HOME for the harnesses. */
  readonly home: string;
  /** CLAUDE_CONFIG_DIR. */
  readonly claudeHome: string;
  /** CODEX_HOME. */
  readonly codexHome: string;
  /** The current turn's model token. */
  readonly tokenFile: string;
}

export const machineLayout = (path: Path.Path, root: string): MachineLayout => ({
  home: path.join(root, "home"),
  claudeHome: path.join(root, "claude"),
  codexHome: path.join(root, "codex"),
  tokenFile: path.join(root, "model-token"),
});

/** Host variables a harness may inherit. Everything else, credentials included, stays behind. */
const INHERITED = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  // A gateway behind a private CA (local development) must still be trusted.
  "NODE_EXTRA_CA_CERTS",
];

export function harnessEnvironment(
  host: NodeJS.ProcessEnv,
  layout: MachineLayout,
  gatewayUrl: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of INHERITED) {
    const value = host[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    HOME: layout.home,
    ANTHROPIC_BASE_URL: gatewayEndpoint(gatewayUrl, "anthropic"),
    // Telemetry and update checks would go to Anthropic directly, with no key.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

const gatewayEndpoint = (gatewayUrl: string, provider: keyof typeof MODEL_GATEWAY_PATHS) =>
  `${gatewayUrl.replace(/\/+$/, "")}${MODEL_GATEWAY_PATHS[provider]}`;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A TOML basic string. */
const tomlString = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Codex's model provider: the gateway's OpenAI endpoint, with the turn's token
 * as bearer; and the Runner's context server, when there is one.
 */
const codexConfig = (layout: MachineLayout, gatewayUrl: string, contextMcpUrl: string | null) =>
  [
    'model_provider = "signalbox"',
    "",
    "[model_providers.signalbox]",
    'name = "Signalbox"',
    `base_url = ${tomlString(`${gatewayEndpoint(gatewayUrl, "openai")}/v1`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
    "[model_providers.signalbox.auth]",
    'command = "cat"',
    `args = [${tomlString(layout.tokenFile)}]`,
    "",
    ...(contextMcpUrl === null
      ? []
      : ["[mcp_servers.signalbox]", `url = ${tomlString(contextMcpUrl)}`, ""]),
  ].join("\n");

export const claudeSettings = (base: ClaudeSettings, layout: MachineLayout): ClaudeSettings => ({
  ...base,
  homePath: layout.claudeHome,
});

/** Codex reads its provider from `config.toml` in its own home (see `prepareMachine`). */
export const codexSettings = (base: CodexSettings, layout: MachineLayout): CodexSettings => ({
  ...base,
  homePath: layout.codexHome,
  shadowHomePath: "",
  launchArgs: "",
});

/** The user settings Claude Code reads from its config dir. */
const ClaudeUserSettingsJson = Schema.fromJsonString(
  Schema.Struct({ apiKeyHelper: Schema.String }),
);
const encodeClaudeUserSettings = Schema.encodeEffect(ClaudeUserSettingsJson);

/**
 * Creates the machine's directories, Claude's `apiKeyHelper` and Codex's model
 * provider, and points Codex at the context server (#141). Claude gets the
 * context server per query (`withContextServer`).
 */
export const prepareMachine = Effect.fn("prepareMachine")(function* (
  layout: MachineLayout,
  gatewayUrl: string,
  contextMcpUrl: string | null = null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const directory of [layout.home, layout.claudeHome, layout.codexHome]) {
    yield* fs.makeDirectory(directory, { recursive: true });
  }
  const settings = yield* encodeClaudeUserSettings({
    apiKeyHelper: `cat ${shellQuote(layout.tokenFile)}`,
  });
  yield* fs.writeFileString(path.join(layout.claudeHome, "settings.json"), settings);
  yield* fs.writeFileString(
    path.join(layout.codexHome, "config.toml"),
    codexConfig(layout, gatewayUrl, contextMcpUrl),
  );
  yield* writeModelToken(layout, "");
});

/** Replaces the token in one step, so a harness never reads half of it. */
export const writeModelToken = Effect.fn("writeModelToken")(function* (
  layout: MachineLayout,
  token: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const staged = `${layout.tokenFile}.next`;
  yield* fs.writeFileString(staged, token, { mode: 0o600 });
  // `mode` only applies to a new file; a leftover staged file keeps its own.
  yield* fs.chmod(staged, 0o600);
  yield* fs.rename(staged, layout.tokenFile);
});
