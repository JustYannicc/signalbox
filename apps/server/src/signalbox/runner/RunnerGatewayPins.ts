import { MODEL_GATEWAY_PATHS } from "@signalbox/runner-protocol/RunnerProtocol";

export { routesHarness } from "@signalbox/runner-protocol/HarnessSecretPolicy";

import type { MachineLayout } from "./RunnerModelAccess.ts";

/**
 * What keeps both harnesses on the ModelGateway (#600), whose scrubber is all
 * that keeps a folder's secrets from the model's provider (#591). Nothing a
 * repository, the agent or a folder secret sets may take them off it:
 *
 * - Claude Code gets its key helper and gateway again as flag settings
 *   (`--settings`), which outrank the user, project and local settings files.
 * - Codex gets its provider and telemetry again as `-c` overrides, which
 *   outrank every `config.toml`.
 * - Variables they read only as they start come from the Runner alone: folder
 *   secrets can't set any `routesHarness` matches (`RunnerSecrets.ts`).
 *
 * Which settings and variables do this changes between releases, so the image
 * test holds the Dockerfile to the versions this was checked against.
 */

const gatewayEndpoint = (gatewayUrl: string, provider: keyof typeof MODEL_GATEWAY_PATHS) =>
  `${gatewayUrl.replace(/\/+$/, "")}${MODEL_GATEWAY_PATHS[provider]}`;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A TOML basic string. */
export const tomlString = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** One argument in double quotes, as `tokenizeCliArgs` reads them back. */
const cliQuote = (value: string) => `"${value.replaceAll(/["\\$`]/g, "\\$&")}"`;

/** The harness versions the pins below were checked against; the image test holds them to the Dockerfile's. */
export const GATEWAY_PINS_CHECKED_ON = { claudeCode: "2.1.292", codex: "0.160.1" } as const;

/** Where Claude Code's model requests go; the machine's environment and its flag settings both set it. */
export const claudeGateway = (gatewayUrl: string) => ({
  ANTHROPIC_BASE_URL: gatewayEndpoint(gatewayUrl, "anthropic"),
  // Telemetry and update checks would go to Anthropic directly, with no key.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

/**
 * What a settings file could set to take Claude Code off the gateway, each of
 * which did on Claude Code 2.1.292: a key of its own, another provider, a
 * proxy, or OpenTelemetry export of prompts and tool output. Blank is unset to
 * Claude Code. `ANTHROPIC_UNIX_SOCKET` is read only at start, so only a folder
 * secret could set it, and those can't.
 */
const CLAUDE_UNSET = Object.fromEntries(
  [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
  ].map((name) => [name, ""]),
);

export const claudeKeyHelper = (layout: MachineLayout) => `cat ${shellQuote(layout.tokenFile)}`;

/**
 * Claude Code's flag settings for every Runner query (`--settings`): its key
 * helper and gateway, over anything the user, project or local settings set.
 */
export const claudeGatewaySettings = (layout: MachineLayout, gatewayUrl: string) => ({
  apiKeyHelper: claudeKeyHelper(layout),
  env: {
    ...claudeGateway(gatewayUrl),
    ...CLAUDE_UNSET,
  } as Readonly<Record<string, string>>,
});

export type ClaudeGatewaySettings = ReturnType<typeof claudeGatewaySettings>;

/**
 * Codex's model provider and telemetry, as dotted TOML keys: its `config.toml`
 * has them for the agent's own `codex`, and the Runner's app-server gets them
 * again as `-c` overrides. Codex 0.160.1 ignores all of them in a project's
 * `.codex/config.toml`, but the agent can rewrite its `config.toml`. It also
 * refuses a `profile` there; profiles come only from `--profile`.
 */
export const codexGatewayConfig = (layout: MachineLayout, gatewayUrl: string) =>
  [
    ["model_provider", '"signalbox"'],
    ["model_providers.signalbox.name", '"Signalbox"'],
    [
      "model_providers.signalbox.base_url",
      tomlString(`${gatewayEndpoint(gatewayUrl, "openai")}/v1`),
    ],
    ["model_providers.signalbox.wire_api", '"responses"'],
    ["model_providers.signalbox.requires_openai_auth", "false"],
    ["model_providers.signalbox.supports_websockets", "false"],
    ["model_providers.signalbox.auth.command", '"cat"'],
    ["model_providers.signalbox.auth.args", `[${tomlString(layout.tokenFile)}]`],
    ["otel.exporter", '"none"'],
    ["otel.trace_exporter", '"none"'],
    ["otel.metrics_exporter", '"none"'],
    ["otel.log_user_prompt", "false"],
    ["analytics.enabled", "false"],
  ].map(([key, value]) => `${key} = ${value}`);

/** Codex's pins as its launch arguments. */
export const codexGatewayArgs = (layout: MachineLayout, gatewayUrl: string) =>
  codexGatewayConfig(layout, gatewayUrl)
    .map((pin) => `-c ${cliQuote(pin)}`)
    .join(" ");
