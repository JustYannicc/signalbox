// @effect-diagnostics nodeBuiltinImport:off - runs the helper command the harness would run.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, CodexSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  claudeSettings,
  codexSettings,
  harnessEnvironment,
  machineLayout,
  prepareMachine,
  writeModelToken,
} from "./RunnerModelAccess.ts";

const GATEWAY = "http://127.0.0.1:8788";
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeUnknownSync(ClaudeSettings)({});
const DEFAULT_CODEX_SETTINGS = Schema.decodeUnknownSync(CodexSettings)({});

describe("RunnerModelAccess", () => {
  it.effect("keeps the host's credentials and logins away from the harnesses", () =>
    Effect.gen(function* () {
      const layout = machineLayout(yield* Path.Path, "/machines/thread-1");
      const environment = harnessEnvironment(
        {
          PATH: "/usr/bin",
          HOME: "/Users/me",
          ANTHROPIC_API_KEY: "sk-ant-host",
          ANTHROPIC_AUTH_TOKEN: "host-token",
          OPENAI_API_KEY: "sk-host",
          CODEX_HOME: "/Users/me/.codex",
          CLAUDE_CONFIG_DIR: "/Users/me/.claude",
          T3CODE_CODEX_LAUNCH_ARGS: "-c model_provider=openai",
        },
        layout,
        GATEWAY,
      );
      expect(environment).toEqual({
        PATH: "/usr/bin",
        HOME: "/machines/thread-1/home",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8788/anthropic",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      });
      expect(claudeSettings(DEFAULT_CLAUDE_SETTINGS, layout).homePath).toBe(layout.claudeHome);
      expect(codexSettings(DEFAULT_CODEX_SETTINGS, layout)).toMatchObject({
        homePath: layout.codexHome,
        shadowHomePath: "",
        launchArgs: "",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("gives both harnesses the current turn's token through their helpers", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-machine-"));
      const layout = machineLayout(yield* Path.Path, NodePath.join(root, "it's a machine"));
      yield* prepareMachine(layout, GATEWAY);
      const settings = JSON.parse(
        NodeFS.readFileSync(NodePath.join(layout.claudeHome, "settings.json"), "utf8"),
      ) as { readonly apiKeyHelper: string };
      const claudeHelper = () => NodeChildProcess.execSync(settings.apiKeyHelper).toString();
      const codexConfig = NodeFS.readFileSync(
        NodePath.join(layout.codexHome, "config.toml"),
        "utf8",
      );
      expect(codexConfig).toContain('base_url = "http://127.0.0.1:8788/openai/v1"');
      expect(codexConfig).toContain(
        `command = "cat"\nargs = [${JSON.stringify(layout.tokenFile)}]`,
      );

      expect(claudeHelper()).toBe("");
      yield* writeModelToken(layout, "sbm1.turn-1");
      expect(claudeHelper()).toBe("sbm1.turn-1");
      yield* writeModelToken(layout, "sbm1.turn-2");
      expect(claudeHelper()).toBe("sbm1.turn-2");
      expect(NodeFS.statSync(layout.tokenFile).mode & 0o777).toBe(0o600);
      NodeFS.rmSync(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("points Codex at the Runner's context server (#141)", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-machine-"));
      const layout = machineLayout(yield* Path.Path, root);
      yield* prepareMachine(layout, GATEWAY, "http://127.0.0.1:41234/mcp");
      expect(NodeFS.readFileSync(NodePath.join(layout.codexHome, "config.toml"), "utf8")).toContain(
        '[mcp_servers.signalbox]\nurl = "http://127.0.0.1:41234/mcp"',
      );
      NodeFS.rmSync(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
