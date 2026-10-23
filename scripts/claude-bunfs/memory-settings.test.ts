import { describe, expect, it } from "vite-plus/test";
import { CLAUDE_MEMORY_DEFAULT_ENV } from "@t3tools/contracts/harnessMemorySettings";
import { assertClaudeMemorySettings as assertMemorySettings } from "./memory-settings-claude.ts";

const key = "BASH_MAX_OUTPUT_LENGTH";
const pin = CLAUDE_MEMORY_DEFAULT_ENV[key];
const pins = { [key]: pin };
const check = (source: string) => assertMemorySettings(new Map([["release.js", source]]), pins);

describe("native memory setting release guard", () => {
  it("accepts an explicitly pinned native default", () => {
    expect(() => check(`const limit = Number(process.env.${key}) || ${pin};`)).not.toThrow();
  });

  it.each(["", `const limit = Number(process.env.RENAMED_MEMORY_LIMIT) || ${pin};`])(
    "fails when the release drops or renames the setting",
    (source) => {
      expect(() => check(source)).toThrow(`RELEASE_MEMORY_SETTING_MISSING: ${key}`);
    },
  );

  it("fails when the release changes its default", () => {
    expect(() => check(`const limit = Number(process.env.${key}) || ${Number(pin) + 1};`)).toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`,
    );
  });

  it.each([
    `// process.env.${key} || ${pin}`,
    `const text = "process.env.${key} || ${pin}";`,
    `function f(process) { return process.env.${key} || ${pin}; }`,
    `const process = { env: { ${key}: "${pin}" } }; process.env.${key};`,
    `process.env.${key} = "${pin}";`,
  ])("does not accept text, shadowed objects or writes as a package read", (source) => {
    expect(() => check(source)).toThrow(`RELEASE_MEMORY_SETTING_MISSING: ${key}`);
  });

  it("fails closed when the native default cannot be proven", () => {
    expect(() => check(`const limit = Number(process.env.${key}) || getDefault();`)).toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${key}`,
    );
  });
});
