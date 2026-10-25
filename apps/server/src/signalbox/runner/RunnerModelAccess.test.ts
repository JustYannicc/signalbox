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
  runnerEnvironments,
  writeModelToken,
} from "./RunnerModelAccess.ts";
import { runnerPaths } from "./RunnerPaths.ts";

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
      expect(codexSettings(DEFAULT_CODEX_SETTINGS, layout, GATEWAY)).toMatchObject({
        homePath: layout.codexHome,
        shadowHomePath: "",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("launches a project-local vp from a colon-free cloud thread path", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-tool-path-"));
      try {
        const path = yield* Path.Path;
        const thread = runnerPaths(
          path,
          NodePath.join(root, "runner's home"),
          "thread:with:colons",
        );
        const layout = machineLayout(path, thread.machineRoot);
        NodeFS.mkdirSync(layout.home, { recursive: true });
        const resetPath = NodePath.join(root, "empty-bin");
        NodeFS.mkdirSync(resetPath);
        const bin = NodePath.join(thread.cwd, "node_modules", ".bin");
        NodeFS.mkdirSync(bin, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(bin, "vp"),
          `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const entries = process.env.PATH.split(path.delimiter);
if (
  path.delimiter === ":" &&
  [
    process.cwd(),
    process.env.PWD,
    process.env.HOME,
    ...entries,
  ].some((value) => value.includes(":"))
) {
  console.error("path segment contains separator :");
  process.exit(2);
}
if (
  fs.realpathSync(entries[0]) !==
  fs.realpathSync(path.join(process.cwd(), "node_modules", ".bin"))
) {
  process.exit(3);
}
fs.writeFileSync(path.join(process.env.HOME, "vp-ran"), process.cwd());
console.log(JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD, home: process.env.HOME }));
`,
          { mode: 0o755 },
        );

        const { dependencyEnvironment, toolEnvironment: environment } = runnerEnvironments(
          { PATH: process.env.PATH, HOME: "/host/home", OPENAI_API_KEY: "host-key" },
          layout,
          GATEWAY,
          {},
          thread.cwd,
        );
        yield* prepareMachine(layout, GATEWAY, {}, thread.cwd);
        NodeFS.writeFileSync(
          NodePath.join(layout.home, ".bash_profile"),
          `export PATH=${JSON.stringify(resetPath)}\n`,
        );
        const { BASH_ENV: _bashEnv, ...environmentWithoutBashEnv } = environment;
        const withoutBootstrap = NodeChildProcess.spawnSync(
          "/bin/bash",
          ["-lc", "command -v vp && vp --version"],
          {
            cwd: thread.cwd,
            env: environmentWithoutBashEnv,
            encoding: "utf8",
          },
        );
        expect(withoutBootstrap.status).not.toBe(0);

        const child = NodeChildProcess.spawnSync(
          "/bin/bash",
          ["-lc", "command -v vp && vp --version"],
          {
            cwd: thread.cwd,
            env: environment,
            encoding: "utf8",
          },
        );

        expect(child.status).toBe(0);
        expect(child.stderr).toBe("");
        const lines = child.stdout.trim().split("\n");
        expect(lines[0]).toBe(NodePath.join(bin, "vp"));
        const launched = JSON.parse(lines[1]!) as {
          cwd: string;
          pwd: string;
          home: string;
        };
        expect(launched.pwd).toBe(thread.cwd);
        expect(launched.home).toBe(layout.home);
        expect(NodeFS.realpathSync(launched.cwd)).toBe(NodeFS.realpathSync(thread.cwd));
        expect(
          NodeFS.realpathSync(NodeFS.readFileSync(NodePath.join(layout.home, "vp-ran"), "utf8")),
        ).toBe(NodeFS.realpathSync(thread.cwd));
        expect(environment.PATH?.split(NodePath.delimiter)[0]).toBe(bin);
        expect(dependencyEnvironment.PATH?.split(NodePath.delimiter)[0]).not.toBe(bin);
        expect(environment.OPENAI_API_KEY).toBeUndefined();
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
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
      expect(codexConfig).toContain(
        'model_providers.signalbox.base_url = "http://127.0.0.1:8788/openai/v1"',
      );
      expect(codexConfig).toContain(
        `model_providers.signalbox.auth.command = "cat"\nmodel_providers.signalbox.auth.args = [${JSON.stringify(layout.tokenFile)}]`,
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

  it.effect("points Codex at the Runner's MCP servers (#141, #402)", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-machine-"));
      const layout = machineLayout(yield* Path.Path, root);
      yield* prepareMachine(layout, GATEWAY, {
        signalbox: "http://127.0.0.1:41234/mcp",
        "t3-code": "http://127.0.0.1:41234/browser",
      });
      const config = NodeFS.readFileSync(NodePath.join(layout.codexHome, "config.toml"), "utf8");
      expect(config).toContain(
        '[mcp_servers."signalbox"]\nurl = "http://127.0.0.1:41234/mcp"\ntool_timeout_sec = 3605',
      );
      expect(config).toContain(
        '[mcp_servers."t3-code"]\nurl = "http://127.0.0.1:41234/browser"\ntool_timeout_sec = 300',
      );
      NodeFS.rmSync(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
