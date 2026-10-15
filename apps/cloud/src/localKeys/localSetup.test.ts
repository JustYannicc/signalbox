// @effect-diagnostics nodeBuiltinImport:off - runs the served script under real node, as a person's computer does.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { setupScript } from "./localSetup.ts";

/**
 * The setup script as a person runs it: its served text piped into `node -`,
 * against a gateway that knows one key, in throwaway config directories.
 */

const GOOD = "sbk_good";
let gateway: NodeHttp.Server;
let gatewayUrl = "";

beforeAll(async () => {
  gateway = NodeHttp.createServer((request, response) => {
    const ok =
      request.url === "/anthropic/v1/models" && request.headers.authorization === `Bearer ${GOOD}`;
    response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        ok
          ? { data: [] }
          : {
              type: "error",
              error: { type: "authentication_error", message: "This Signalbox key was revoked." },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as NodeNet.AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => gateway.close(() => resolve())));

const makeComputer = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-local-"));
  const claude = NodePath.join(home, "claude");
  const codex = NodePath.join(home, "codex");
  const run = (...args: ReadonlyArray<string>) =>
    new Promise<{ readonly code: number | null; readonly output: string }>((resolve) => {
      const child = NodeChildProcess.spawn(process.execPath, ["-", ...args], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: codex,
        },
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("close", (code) => resolve({ code, output }));
      child.stdin.end(
        setupScript({
          setupUrl: "https://cloud.test/api/local-keys/setup",
          anthropicUrl: `${gatewayUrl}/anthropic`,
          openaiUrl: `${gatewayUrl}/openai/v1`,
          keyPrefix: "sbk_",
        }),
      );
    });
  const read = (file: string) => {
    const path = NodePath.join(home, file);
    return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : null;
  };
  const writeFile = (file: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(home, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home, file), text);
  };
  return { home, run, read, writeFile };
};

const CLAUDE_SETTINGS = `${JSON.stringify(
  {
    model: "opus",
    env: { FOO: "1", ANTHROPIC_API_KEY: "sk-ant-old" },
    apiKeyHelper: "op read key",
  },
  null,
  2,
)}\n`;

const CODEX_CONFIG = `# my settings
model = "gpt-5.5"
model_provider = "openai"

[mcp_servers.docs]
url = "https://docs.test/mcp"
`;

describe("local setup", () => {
  it("puts Claude Code and Codex on the pool, keeping everything else, and undoes it exactly", async () => {
    const computer = makeComputer();
    computer.writeFile("claude/settings.json", CLAUDE_SETTINGS);
    computer.writeFile("codex/config.toml", CODEX_CONFIG);

    const first = await computer.run(GOOD);
    expect(first.code, first.output).toBe(0);
    // Running it again changes nothing.
    expect((await computer.run(GOOD)).code).toBe(0);

    const claudeKey = NodePath.join(computer.home, "claude", "signalbox-key");
    expect(JSON.parse(computer.read("claude/settings.json") ?? "")).toEqual({
      model: "opus",
      env: { FOO: "1", ANTHROPIC_BASE_URL: `${gatewayUrl}/anthropic` },
      apiKeyHelper: `cat '${claudeKey}'`,
    });
    expect(computer.read("claude/signalbox-key")).toBe(GOOD);
    expect(NodeFS.statSync(claudeKey).mode & 0o777).toBe(0o600);

    const codexKey = NodePath.join(computer.home, "codex", "signalbox-key");
    expect(computer.read("codex/config.toml")).toBe(`# my settings
model = "gpt-5.5"
model_provider = "signalbox"

[mcp_servers.docs]
url = "https://docs.test/mcp"

# >>> signalbox: written by Signalbox setup; remove with its --undo
[model_providers.signalbox]
name = "Signalbox"
base_url = "${gatewayUrl}/openai/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[model_providers.signalbox.auth]
command = "cat"
args = ["${codexKey}"]
# <<< signalbox
`);

    const undone = await computer.run("--undo");
    expect(undone.code, undone.output).toBe(0);
    expect(computer.read("claude/settings.json")).toBe(CLAUDE_SETTINGS);
    expect(computer.read("codex/config.toml")).toBe(CODEX_CONFIG);
    expect(computer.read("claude/signalbox-key")).toBeNull();
    expect(computer.read("codex/signalbox-previous.json")).toBeNull();
  });

  it("sets up a computer with no config yet, and leaves none after undoing", async () => {
    const computer = makeComputer();
    expect((await computer.run(GOOD)).code).toBe(0);
    expect(
      computer
        .read("codex/config.toml")
        ?.startsWith('model_provider = "signalbox"\n\n# >>> signalbox'),
    ).toBe(true);
    expect((await computer.run("--undo")).code).toBe(0);
    expect(computer.read("claude/settings.json")).toBeNull();
    expect(computer.read("codex/config.toml")).toBeNull();
  });

  it("changes nothing when either config can't be read", async () => {
    const computer = makeComputer();
    computer.writeFile("claude/settings.json", CLAUDE_SETTINGS);
    computer.writeFile("codex/config.toml", '[model_providers.signalbox]\nname = "mine"\n');
    const result = await computer.run(GOOD);
    expect(result.code).toBe(1);
    expect(result.output).toContain('already has a "signalbox" model provider');
    expect(computer.read("claude/settings.json")).toBe(CLAUDE_SETTINGS);
    expect(computer.read("claude/signalbox-key")).toBeNull();
    expect(computer.read("claude/signalbox-previous.json")).toBeNull();
  });

  it("changes nothing when the pool doesn't take the key", async () => {
    const computer = makeComputer();
    const result = await computer.run("sbk_revoked");
    expect(result.code).toBe(1);
    expect(result.output).toContain("This Signalbox key was revoked.");
    expect(NodeFS.readdirSync(computer.home)).toEqual([]);
  });
});
