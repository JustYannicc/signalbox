import { describe, expect, it } from "vite-plus/test";
import { assertClaudeMemorySettings as assertMemorySettings } from "./memory-settings-claude.ts";

const pins = { PACKAGE_MEMORY_LIMIT: "25000" };
const check = (source: string) => assertMemorySettings(new Map([["release.js", source]]), pins);

describe("native memory setting release guard", () => {
  it("accepts an explicitly pinned native default", () => {
    expect(() =>
      check("const limit = Number(process.env.PACKAGE_MEMORY_LIMIT) || 25000;"),
    ).not.toThrow();
  });

  it.each(["", "const limit = Number(process.env.RENAMED_MEMORY_LIMIT) || 25000;"])(
    "fails when the release drops or renames the setting",
    (source) => {
      expect(() => check(source)).toThrow("RELEASE_MEMORY_SETTING_MISSING: PACKAGE_MEMORY_LIMIT");
    },
  );

  it("fails when the release changes its default", () => {
    expect(() => check("const limit = Number(process.env.PACKAGE_MEMORY_LIMIT) || 30000;")).toThrow(
      "RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: PACKAGE_MEMORY_LIMIT",
    );
  });

  it.each([
    "// process.env.PACKAGE_MEMORY_LIMIT || 25000",
    'const text = "process.env.PACKAGE_MEMORY_LIMIT || 25000";',
    "function f(process) { return process.env.PACKAGE_MEMORY_LIMIT || 25000; }",
    'const process = { env: { PACKAGE_MEMORY_LIMIT: "25000" } }; process.env.PACKAGE_MEMORY_LIMIT;',
    'process.env.PACKAGE_MEMORY_LIMIT = "25000";',
  ])("does not accept text, shadowed objects or writes as a package read", (source) => {
    expect(() => check(source)).toThrow("RELEASE_MEMORY_SETTING_MISSING: PACKAGE_MEMORY_LIMIT");
  });

  it("fails closed when the native default cannot be proven", () => {
    expect(() =>
      check("const limit = Number(process.env.PACKAGE_MEMORY_LIMIT) || getDefault();"),
    ).toThrow("RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: PACKAGE_MEMORY_LIMIT");
  });
});
