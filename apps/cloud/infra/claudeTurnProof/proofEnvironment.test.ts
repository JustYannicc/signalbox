// @effect-diagnostics nodeBuiltinImport:off - actual installed package exports in an isolated resolver test.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { createNodeBridge } from "../../src/isolate/NodeBridge.ts";
import {
  createProofEnvironment,
  createProofIdentity,
  createProofProcessEnvironment,
} from "./proofEnvironment.ts";

const require = NodeModule.createRequire(import.meta.url);

describe("proof package resolver", () => {
  it("exposes real package identities only after their loader completes", async () => {
    const yaml: object = require("yaml");
    const undici: object = require("undici");
    const bridge = createNodeBridge({ path: NodePath });
    const environment = createProofEnvironment({
      bridge: () => bridge,
      loadPackages: async () => ({ yaml, undici }),
      onBuiltinFailure: () => {},
    });
    const guestRequire = environment.module.createRequire("/guest/claude.js");
    expect(() => guestRequire("yaml")).toThrow(
      "Prepared module graph does not provide require: yaml",
    );
    await environment.load();
    expect(guestRequire("yaml")).toBe(yaml);
    expect(guestRequire("undici")).toBe(undici);
    expect(guestRequire("node:path")).toBe(NodePath);
    const jsc = guestRequire("bun:jsc");
    expect(jsc).toHaveProperty("heapStats");
    expect(() => guestRequire("ws")).toThrow("Prepared module graph does not provide require: ws");
  });

  it("records and rethrows an unknown builtin instead of using ambient require", () => {
    const missing: string[] = [];
    const bridge = createNodeBridge({});
    const environment = createProofEnvironment({
      bridge: () => bridge,
      loadPackages: async () => ({ yaml: {}, undici: {} }),
      onBuiltinFailure: (specifier) => missing.push(specifier),
    });
    expect(() =>
      environment.module.createRequire("/guest/environment.js")(
        "node:signalbox_missing_proof_builtin",
      ),
    ).toThrow("Unknown Node builtin: node:signalbox_missing_proof_builtin");
    expect(missing).toEqual(["node:signalbox_missing_proof_builtin"]);
  });
});

describe("Claude full-tools proof configuration", () => {
  it("keeps the existing environment except SIMPLE and enables the documented tools list", () => {
    expect(createProofProcessEnvironment()).toEqual({
      HOME: "/home/claude",
      TMPDIR: "/tmp",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      CLAUDE_CODE_SHELL: "/bin/bash",
      USE_BUILTIN_RIPGREP: "0",
      TERM: "dumb",
      NO_COLOR: "1",
      ANTHROPIC_API_KEY: "mock-only-dummy-key",
      ANTHROPIC_BASE_URL: "http://mock.anthropic.invalid",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      CI: "1",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      NO_PROXY: "*",
      no_proxy: "*",
    });
    const identity = createProofIdentity("run all configured tools");
    expect(identity.argv).toEqual([
      "claude",
      "/$bunfs/root/cli",
      "-p",
      "run all configured tools",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Read,Edit,Write,Grep,Glob,Bash",
      "--tools",
      "Read,Edit,Write,Grep,Glob,Bash",
    ]);
  });
});
