// @effect-diagnostics nodeBuiltinImport:off - Checks the codemod against the checked-out tree.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  EXTERNAL_CONTRACT_PROPERTIES,
  PRESERVED_TEST_LINES,
  rebrandFile,
  rebrandScript,
} from "./rebrand.ts";

// Upstream moves files often. A stale key silently stops protecting a contract,
// so the next sync rebrands it (Codex's clientInfo did once).
it("keys its per-file exceptions by files that exist", () => {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const missing = [
    ...Object.keys(EXTERNAL_CONTRACT_PROPERTIES),
    ...Object.keys(PRESERVED_TEST_LINES),
  ].filter((file) => !NodeFS.existsSync(NodePath.join(root, file)));
  expect(missing).toEqual([]);
});

describe("rebrandScript", () => {
  it("renames product names in strings, templates, and JSX text", () => {
    const code = [
      'const title = "Set up T3 Code";',
      "const hint = `Restart T3 Code on ${host} or sign in to T3 Connect.`;",
      "const node = <p>Keep T3 Code running.</p>;",
    ].join("\n");

    expect(rebrandScript("apps/web/src/Example.tsx", code)).toBe(
      [
        'const title = "Set up Signalbox";',
        "const hint = `Restart Signalbox on ${host} or sign in to Signalbox Connect.`;",
        "const node = <p>Keep Signalbox running.</p>;",
      ].join("\n"),
    );
  });

  it("leaves comments, identifiers, env vars, and package names alone", () => {
    const code = [
      "// T3 Code keeps this in sync",
      'import { T3Wordmark } from "@t3tools/shared/brand";',
      'const home = process.env.T3CODE_HOME ?? "t3.json";',
    ].join("\n");

    expect(rebrandScript("apps/web/src/Example.ts", code)).toBe(code);
  });

  it("renames the CLI where users type it", () => {
    const code = [
      'const a = "Run `t3 service install` to repair it.";',
      'const b = "Start one with `npx t3 serve`, or `npx t3@nightly serve`.";',
      "const c = `Installed with t3@${version}.`;",
      'const d = "Download a newer t3 and switch this machine to it.";',
      "const e = `t3 ${subcommand}`;",
      'const f = "Remove it with `npm uninstall -g t3`.";',
      'const g = "Open t3code://threads/1";',
    ].join("\n");

    expect(rebrandScript("apps/server/src/cli/example.ts", code)).toBe(
      [
        'const a = "Run `signalbox service install` to repair it.";',
        'const b = "Start one with `npx signalbox-cli serve`, or `npx signalbox-cli@nightly serve`.";',
        "const c = `Installed with signalbox@${version}.`;",
        'const d = "Download a newer signalbox and switch this machine to it.";',
        "const e = `signalbox ${subcommand}`;",
        'const f = "Remove it with `npm uninstall -g signalbox-cli`.";',
        'const g = "Open signalbox://threads/1";',
      ].join("\n"),
    );
  });

  it("renames the short product name in prose but not other T3 names", () => {
    const code = [
      'const a = "Open T3 to connect";',
      "const b = `${hidden} more in T3`;",
      'const c = "Published by T3 Tools";',
      'const d = "applies to T3 Chat";',
      'const e = "per T3 home";',
    ].join("\n");

    expect(rebrandScript("apps/web/src/Example.ts", code)).toBe(
      [
        'const a = "Open Signalbox to connect";',
        "const b = `${hidden} more in Signalbox`;",
        'const c = "Published by T3 Tools";',
        'const d = "applies to T3 Chat";',
        'const e = "per Signalbox home";',
      ].join("\n"),
    );
  });

  it("does not mistake other t3 tokens for the CLI", () => {
    const code = [
      'const theme = "t3";',
      'const header = "x-tenant = t3 ,";',
      'const path = "/.well-known/t3/environment";',
      'const branch = "t3code/1a2b3c4d";',
      'const icon = "t3-code";',
    ].join("\n");

    expect(rebrandScript("apps/web/src/Example.ts", code)).toBe(code);
  });

  it("keeps external contracts in their own files only", () => {
    const code =
      'const p = { clientInfo: { name: "T3 Code", title: "T3 Code" }, message: "T3 Code" };';

    expect(rebrandScript("apps/server/src/provider/CodexProvider.ts", code)).toBe(
      'const p = { clientInfo: { name: "T3 Code", title: "T3 Code" }, message: "Signalbox" };',
    );
    expect(rebrandScript("apps/server/src/mcp/McpHttpServer.ts", code)).toBe(
      'const p = { clientInfo: { name: "Signalbox", title: "Signalbox" }, message: "Signalbox" };',
    );
  });

  it("leaves test titles alone but keeps expectations in step with the source", () => {
    const code = [
      'it("prints the t3 app hint for T3 Code", () => {',
      '  expect(hint()).toBe("Run `t3 app` in T3 Code.");',
      "});",
      'const cases = [{ name: "blank t3 falls through", value: "T3 Code" }];',
    ].join("\n");

    expect(rebrandScript("apps/server/src/cli/app.test.ts", code)).toBe(
      [
        'it("prints the t3 app hint for T3 Code", () => {',
        '  expect(hint()).toBe("Run `signalbox app` in Signalbox.");',
        "});",
        'const cases = [{ name: "blank t3 falls through", value: "Signalbox" }];',
      ].join("\n"),
    );
  });
});

describe("preserved text", () => {
  it("renames URL-encoded names and keeps listed test lines", () => {
    expect(
      rebrandScript("apps/web/src/a.test.ts", 'const body = "client_label=T3+Code+Mobile";'),
    ).toBe('const body = "client_label=Signalbox+Mobile";');
    const contract = 'assert.strictEqual(url.searchParams.get("agent_name_hint"), "T3 Code");';
    expect(rebrandScript("apps/server/src/provider/CodexChatGptAuth.test.ts", contract)).toBe(
      contract,
    );
  });
});

describe("rebrandFile", () => {
  it("renames docs, including data paths and install URLs, but keeps upstream credits", () => {
    const doc = [
      "Signalbox is a fork of [T3 Code](https://github.com/pingdotgg/t3code).",
      "T3 Code stores data in `~/.t3/userdata`, separate from each worktree's `.t3`.",
      "curl -fsSL https://t3.codes/install.sh | sh",
      "Run `t3 serve`, or `npx t3@latest`.",
    ].join("\n");

    expect(rebrandFile("docs/user/install.md", doc)).toBe(
      [
        "Signalbox is a fork of [T3 Code](https://github.com/pingdotgg/t3code).",
        "Signalbox stores data in `~/.signalbox/userdata`, separate from each worktree's `.t3`.",
        "curl -fsSL https://raw.githubusercontent.com/JustYannicc/signalbox/main/scripts/install.sh | sh",
        "Run `signalbox serve`, or `npx signalbox-cli@latest`.",
      ].join("\n"),
    );
  });

  it("keeps the maintainer glossary term outside user docs", () => {
    expect(rebrandFile("docs/internals/glossary.md", "the T3 home directory")).toBe(
      "the T3 home directory",
    );
    expect(rebrandFile("docs/user/background-service.md", "the T3 home directory")).toBe(
      "the Signalbox home directory",
    );
  });

  it("skips excluded paths and unknown file types", () => {
    expect(rebrandFile(".github/workflows/ci.yml", "T3 Code")).toBe("T3 Code");
    expect(rebrandFile("infra/relay/src/index.ts", 'const a = "T3 Code";')).toBe(
      'const a = "T3 Code";',
    );
    expect(rebrandFile("assets/logo.svg", "T3 Code")).toBe("T3 Code");
  });

  it("is idempotent", () => {
    const code = 'const a = "Run `t3 serve` in T3 Code via t3code://app";';
    const once = rebrandFile("apps/web/src/Example.ts", code);
    expect(rebrandFile("apps/web/src/Example.ts", once)).toBe(once);
  });
});
