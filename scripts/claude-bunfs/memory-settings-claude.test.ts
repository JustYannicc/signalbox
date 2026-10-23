import { CLAUDE_MEMORY_ENV } from "@t3tools/contracts/harnessMemorySettings";
import { describe, expect, it } from "vite-plus/test";
import { assertClaudeMemorySettings } from "./memory-settings-claude.ts";

const pins = CLAUDE_MEMORY_ENV;
const key = "BASH_MAX_OUTPUT_LENGTH";

const typedSources = new Map([
  [
    "env-table.js",
    `
      const H = { int: (options) => ({ options }) };
      const integer = H.int();
      function Mr(target, descriptors) {
        for (const key in descriptors) {
          Object.defineProperty(target, key, { get: descriptors[key], enumerable: true });
        }
      }
      const table = {};
      Mr(table, {
        CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: () => integer,
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: () => H.int({ min: 1 }),
      });
      export { table };
    `,
  ],
  [
    "env-object.js",
    `
      import { table } from "./env-table.js";
      function read(key, descriptor) {
        return () => descriptor.parse(process.env[key]);
      }
      function makeEnv(registry, target) {
        for (const [key, descriptor] of false ? [] : Object.entries(registry)) {
          Object.defineProperty(target, key, {
            get: read(key, descriptor),
            enumerable: true,
          });
        }
        return target;
      }
      export const a10 = makeEnv({ ...table }, {});
    `,
  ],
  [
    "consumer.js",
    `
      import { a10 } from "./env-object.js";
      function fileReadLimit() {
        const configured = a10.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
        if (configured !== undefined && configured > 0) return configured;
        return;
      }
      const options = { maxTokens: fileReadLimit() ?? 25e3 };
      const toolConcurrency = a10.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY ?? 10;
    `,
  ],
]);

const check = (source: string, expected: Readonly<Record<string, string>> = { [key]: "30000" }) =>
  assertClaudeMemorySettings(new Map([["release.js", source]]), expected);

describe("Claude native memory setting release guard", () => {
  it("proves pinned defaults through direct, parsed, and typed environment reads", () => {
    const directAndParsed = `
      function qje(name, value, fallback, upper) {
        if (!value) return { effective: fallback, status: "valid" };
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return { effective: fallback, status: "invalid" };
        return { effective: Math.min(parsed, upper), status: "valid" };
      }
      const bash = qje(
        "BASH_MAX_OUTPUT_LENGTH",
        process.env.BASH_MAX_OUTPUT_LENGTH,
        3e4,
        150000,
      ).effective;
      const toolConcurrency = process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY ?? 10;
    `;
    const sourceNames = assertClaudeMemorySettings(
      new Map([["release.js", directAndParsed], ...typedSources]),
      pins,
    );
    expect(sourceNames.map(({ key: setting, default: value }) => [setting, value])).toEqual([
      ["BASH_MAX_OUTPUT_LENGTH", "30000"],
      ["CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS", "25000"],
      ["CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY", "10"],
    ]);
  });

  it("accepts native process aliases, including named env imports and destructuring", () => {
    expect(
      assertClaudeMemorySettings(
        new Map([
          [
            "release.js",
            `
              import { env } from "node:process";
              const { env: requiredEnv } = require("process");
              const first = env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY ?? 10;
              const second = requiredEnv["CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY"] ?? 10;
            `,
          ],
        ]),
        { CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "10" },
      ),
    ).toHaveLength(1);
  });

  it.each([
    "",
    'const text = "process.env.BASH_MAX_OUTPUT_LENGTH ?? 30000";',
    "// process.env.BASH_MAX_OUTPUT_LENGTH ?? 30000",
    "function f(process) { return process.env.BASH_MAX_OUTPUT_LENGTH ?? 30000; }",
    'process.env.BASH_MAX_OUTPUT_LENGTH = "30000";',
    "const process = require(moduleName); process.env.BASH_MAX_OUTPUT_LENGTH ?? 30000;",
    "const { env } = require(moduleName); env.BASH_MAX_OUTPUT_LENGTH ?? 30000;",
  ])("does not count text, shadowed globals, dynamic require, or writes as reads", (source) => {
    expect(() => check(source)).toThrow(`RELEASE_MEMORY_SETTING_MISSING: ${key}`);
  });

  it("fails when a typed env read is not registered", () => {
    const unregistered = new Map(typedSources);
    unregistered.set(
      "env-table.js",
      typedSources
        .get("env-table.js")!
        .replace("CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS", "RENAMED_FILE_READ_LIMIT"),
    );
    expect(() =>
      assertClaudeMemorySettings(unregistered, {
        CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "25000",
      }),
    ).toThrow("RELEASE_MEMORY_SETTING_MISSING: CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS");
  });

  it("does not accept a typed registry entry without a consumer read", () => {
    const registryOnly = new Map(typedSources);
    registryOnly.delete("consumer.js");
    expect(() =>
      assertClaudeMemorySettings(registryOnly, {
        CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "25000",
      }),
    ).toThrow("RELEASE_MEMORY_SETTING_MISSING: CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS");
  });

  it("fails closed when a typed integer descriptor adds an unsupported default", () => {
    const changedDescriptor = new Map(typedSources);
    changedDescriptor.set(
      "env-table.js",
      typedSources
        .get("env-table.js")!
        .replace(
          "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: () => integer",
          "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: () => H.int({ default: 9 })",
        ),
    );
    expect(() =>
      assertClaudeMemorySettings(changedDescriptor, {
        CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "25000",
      }),
    ).toThrow("RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS");
  });

  it("rejects an integer descriptor range that excludes the pinned concurrency", () => {
    const changedDescriptor = new Map(typedSources);
    changedDescriptor.set(
      "env-table.js",
      typedSources
        .get("env-table.js")!
        .replace(
          "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: () => H.int({ min: 1 })",
          "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: () => H.int({ min: 11 })",
        ),
    );
    expect(() =>
      assertClaudeMemorySettings(changedDescriptor, {
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "10",
      }),
    ).toThrow("RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY");
  });

  it("does not accept a fallback from a nested, unrelated function return", () => {
    expect(() =>
      check(`
        function readLimit() {
          const configured = process.env.BASH_MAX_OUTPUT_LENGTH;
          function unused() { return configured; }
          return undefined;
        }
        const max = readLimit() ?? 30000;
      `),
    ).toThrow(`RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${key}`);
  });

  it("accepts the absent-env branch of a typed reader and its nullish fallback", () => {
    expect(
      assertClaudeMemorySettings(typedSources, {
        CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "25000",
      }),
    ).toEqual([
      {
        key: "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS",
        source: "consumer.js",
        default: "25000",
      },
    ]);
  });

  it("fails when a native fallback changes", () => {
    expect(() => check("const limit = process.env.BASH_MAX_OUTPUT_LENGTH ?? 30001;")).toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`,
    );
  });

  it("rejects a parser cap below the explicit memory pin", () => {
    expect(() =>
      check(`
        function qje(name, value, fallback, upper) {
          if (!value) return { effective: fallback };
          const parsed = Number(value);
          return { effective: parsed > upper ? upper : parsed };
        }
        const max = qje(
          "BASH_MAX_OUTPUT_LENGTH",
          process.env.BASH_MAX_OUTPUT_LENGTH,
          30000,
          20000,
        ).effective;
      `),
    ).toThrow(`RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`);
  });

  it("fails closed when a native read has no statically proven fallback", () => {
    expect(() =>
      check("const limit = process.env.BASH_MAX_OUTPUT_LENGTH ?? getDefault();"),
    ).toThrow(`RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${key}`);
  });
});
