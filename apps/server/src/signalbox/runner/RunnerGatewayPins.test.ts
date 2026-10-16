// @effect-diagnostics nodeBuiltinImport:off - reads the config.toml the machine is given.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { codexAppServerArgs } from "../../provider/codexLaunchArgs.ts";
import { claudeGatewaySettings } from "./RunnerGatewayPins.ts";
import { codexSettings, machineLayout, prepareMachine } from "./RunnerModelAccess.ts";

const GATEWAY = "http://127.0.0.1:8788";
const DEFAULT_CODEX_SETTINGS = Schema.decodeUnknownSync(CodexSettings)({});

describe("RunnerGatewayPins", () => {
  // Claude Code 2.1.292 sent its model requests elsewhere for each of these
  // when a repository's `.claude/settings.json` set them (#600).
  it.effect("pins Claude Code's gateway, key and telemetry over every settings file", () =>
    Effect.gen(function* () {
      const layout = machineLayout(yield* Path.Path, "/machines/thread-1");
      expect(claudeGatewaySettings(layout, GATEWAY)).toEqual({
        apiKeyHelper: "cat '/machines/thread-1/model-token'",
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:8788/anthropic",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          // Blank is unset to Claude Code.
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
          CLAUDE_CODE_USE_BEDROCK: "",
          CLAUDE_CODE_USE_VERTEX: "",
          CLAUDE_CODE_USE_FOUNDRY: "",
          CLAUDE_CODE_USE_MANTLE: "",
          CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
          CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "",
          CLAUDE_CODE_ENABLE_TELEMETRY: "",
          CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "",
          HTTPS_PROXY: "",
          HTTP_PROXY: "",
          ALL_PROXY: "",
          https_proxy: "",
          http_proxy: "",
          all_proxy: "",
        },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "pins Codex's provider and telemetry as overrides, the same ones its config.toml has",
    () =>
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-machine-"));
        const layout = machineLayout(yield* Path.Path, NodePath.join(root, `it's a "machine"`));
        yield* prepareMachine(layout, GATEWAY);
        const config = NodeFS.readFileSync(NodePath.join(layout.codexHome, "config.toml"), "utf8");
        const { launchArgs } = codexSettings(DEFAULT_CODEX_SETTINGS, layout, GATEWAY);

        // `-c` outranks the user's config.toml and a project's `.codex/config.toml`.
        const argv = codexAppServerArgs(launchArgs);
        const pins = argv.filter((_, index) => argv[index - 1] === "-c");
        expect(argv).toEqual(["app-server", ...pins.flatMap((pin) => ["-c", pin])]);
        expect(pins).toEqual([
          'model_provider = "signalbox"',
          'model_providers.signalbox.name = "Signalbox"',
          'model_providers.signalbox.base_url = "http://127.0.0.1:8788/openai/v1"',
          'model_providers.signalbox.wire_api = "responses"',
          "model_providers.signalbox.requires_openai_auth = false",
          "model_providers.signalbox.supports_websockets = false",
          'model_providers.signalbox.auth.command = "cat"',
          `model_providers.signalbox.auth.args = [${JSON.stringify(layout.tokenFile)}]`,
          'otel.exporter = "none"',
          'otel.trace_exporter = "none"',
          'otel.metrics_exporter = "none"',
          "otel.log_user_prompt = false",
          "analytics.enabled = false",
        ]);
        for (const pin of pins) expect(config.split("\n")).toContain(pin);
        NodeFS.rmSync(root, { recursive: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
