// @effect-diagnostics nodeBuiltinImport:off - PATH needs the host path-list delimiter.
import * as NodePath from "node:path";

import type { ClaudeSettings, CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  claudeGateway,
  claudeKeyHelper,
  codexGatewayArgs,
  codexGatewayConfig,
  tomlString,
} from "./RunnerGatewayPins.ts";
import { INSTRUCTIONS_MAX_BYTES, ROOT_MARKER } from "./RunnerInstructions.ts";

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
 *
 * Nothing a repository, the agent or a folder secret sets takes them off it
 * (#600, `RunnerGatewayPins.ts`).
 *
 * Both harnesses are also set up to read every instruction file a drive with
 * shortcuts brings (#142, `RunnerInstructions.ts`): Claude Code loads
 * `AGENTS.md` beside `CLAUDE.md` rather than only without one, and Codex takes
 * the folder above the checkout as its project root and reads up to
 * `INSTRUCTIONS_MAX_BYTES` of instructions instead of 32 KiB.
 */

export interface MachineLayout {
  /** HOME for the harnesses. */
  readonly home: string;
  /** CLAUDE_CONFIG_DIR. */
  readonly claudeHome: string;
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

const agentToolBashEnvironmentFile = (home: string) =>
  NodePath.join(home, ".signalbox-agent-bash-env");

export function harnessEnvironment(
  host: NodeJS.ProcessEnv,
  layout: MachineLayout,
  gatewayUrl: string,
  /** The machine's dependency and build caches (`RunnerCaches.ts`). */
  caches: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of INHERITED) {
    const value = host[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...caches, HOME: layout.home, ...claudeGateway(gatewayUrl) };
}

/** Makes project-installed commands available to provider shells, including Bash login shells. */
export const agentToolEnvironment = (
  environment: NodeJS.ProcessEnv,
  cwd: string,
): NodeJS.ProcessEnv => {
  const home = environment.HOME;
  return {
    ...environment,
    PATH: [NodePath.join(cwd, "node_modules", ".bin"), environment.PATH]
      .filter((entry): entry is string => entry !== undefined && entry.length > 0)
      .join(NodePath.delimiter),
    PWD: cwd,
    ...(home === undefined ? {} : { BASH_ENV: agentToolBashEnvironmentFile(home) }),
  };
};

/** The Runner environment split: installers get dependency caches; agent tools also get the drive bin. */
export const runnerEnvironments = (
  host: NodeJS.ProcessEnv,
  layout: MachineLayout,
  gatewayUrl: string,
  caches: Readonly<Record<string, string>> = {},
  cwd: string,
  extra: Readonly<Record<string, string>> = {},
) => {
  const dependencyEnvironment = harnessEnvironment(host, layout, gatewayUrl, caches);
  return {
    dependencyEnvironment,
    toolEnvironment: agentToolEnvironment({ ...dependencyEnvironment, ...extra }, cwd),
  };
};

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const agentToolBashEnvironment = (cwd: string) =>
  [
    `_signalbox_agent_tool_bin=${shellQuote(NodePath.join(cwd, "node_modules", ".bin"))}`,
    'case ":${PATH-}:" in',
    '  *":${_signalbox_agent_tool_bin}:"*) ;;',
    '  *) PATH="${_signalbox_agent_tool_bin}${PATH:+:$PATH}" ;;',
    "esac",
    "export PATH",
    "unset _signalbox_agent_tool_bin",
    "",
  ].join("\n");

/** Longer than the login service's 4-minute budget for one sign-in. */
export const MCP_TOOL_TIMEOUT_SEC = 300;

/** The Runner's loopback MCP servers, by the name the harnesses know each as. */
export type RunnerMcpServers = Readonly<Record<string, string>>;

/**
 * Codex's model provider and telemetry (`codexGatewayConfig`), its project
 * docs, and the Runner's MCP servers.
 */
const codexConfig = (layout: MachineLayout, gatewayUrl: string, mcpServers: RunnerMcpServers) =>
  [
    ...codexGatewayConfig(layout, gatewayUrl),
    `project_root_markers = [${tomlString(ROOT_MARKER)}]`,
    `project_doc_max_bytes = ${INSTRUCTIONS_MAX_BYTES}`,
    "",
    ...Object.entries(mcpServers).flatMap(([name, url]) => [
      `[mcp_servers.${tomlString(name)}]`,
      `url = ${tomlString(url)}`,
      // Codex gives a tool call 60 seconds; a sign-in (#576) can take minutes.
      `tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SEC}`,
      "",
    ]),
  ].join("\n");

export const claudeSettings = (base: ClaudeSettings, layout: MachineLayout): ClaudeSettings => ({
  ...base,
  homePath: layout.claudeHome,
});

/** Codex reads its provider from `config.toml` in its own home (see `prepareMachine`), and again from its launch arguments. */
export const codexSettings = (
  base: CodexSettings,
  layout: MachineLayout,
  gatewayUrl: string,
): CodexSettings => ({
  ...base,
  homePath: layout.codexHome,
  shadowHomePath: "",
  launchArgs: codexGatewayArgs(layout, gatewayUrl),
});

/** The user settings Claude Code reads from its config dir. */
const ClaudeUserSettingsJson = Schema.fromJsonString(
  Schema.Struct({
    apiKeyHelper: Schema.String,
    /** Options of Claude Code's built-in plugins, by plugin. */
    pluginConfigs: Schema.Record(
      Schema.String,
      Schema.Struct({ options: Schema.Record(Schema.String, Schema.String) }),
    ),
  }),
);
const encodeClaudeUserSettings = Schema.encodeEffect(ClaudeUserSettingsJson);

/**
 * Creates the machine's directories, Claude's `apiKeyHelper` and Codex's model
 * provider, and points Codex at the Runner's MCP servers: the context server
 * (#141) and the browser (#402). Claude gets them per query (`withContextServer`).
 */
export const prepareMachine = Effect.fn("prepareMachine")(function* (
  layout: MachineLayout,
  gatewayUrl: string,
  mcpServers: RunnerMcpServers = {},
  cwd?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const directory of [layout.home, layout.claudeHome, layout.codexHome]) {
    yield* fs.makeDirectory(directory, { recursive: true });
  }
  if (cwd !== undefined) {
    // Bash login profiles can replace PATH after the provider process starts.
    yield* fs.writeFileString(
      agentToolBashEnvironmentFile(layout.home),
      agentToolBashEnvironment(cwd),
    );
  }
  const settings = yield* encodeClaudeUserSettings({
    apiKeyHelper: claudeKeyHelper(layout),
    // A CLAUDE.md in one folder must not keep another folder's AGENTS.md out.
    pluginConfigs: {
      "agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } },
    },
  });
  yield* fs.writeFileString(path.join(layout.claudeHome, "settings.json"), settings);
  yield* fs.writeFileString(
    path.join(layout.codexHome, "config.toml"),
    codexConfig(layout, gatewayUrl, mcpServers),
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
