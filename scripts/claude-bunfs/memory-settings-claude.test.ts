import {
  CLAUDE_MEMORY_DEFAULT_ENV,
  CLAUDE_MEMORY_RETENTION_ENV,
} from "@t3tools/contracts/harnessMemorySettings";
import { describe, expect, it } from "vite-plus/test";
import { assertClaudeMemorySettings } from "./memory-settings-claude.ts";

const defaultPins = CLAUDE_MEMORY_DEFAULT_ENV;
const retentionPins = CLAUDE_MEMORY_RETENTION_ENV;
const bashKey = "BASH_MAX_OUTPUT_LENGTH";
const fileKey = "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS";
const concurrencyKey = "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY";
const gcKey = "CLAUDE_CODE_TRANSCRIPT_LOCAL_GC";

const typedSources = new Map([
  [
    "env-module.js",
    `
      const H = { int: (options) => ({ options }) };
      function Mr(target, descriptors) {
        for (const key in descriptors) {
          Object.defineProperty(target, key, { get: descriptors[key], enumerable: true });
        }
      }
      function _t(key, descriptor) {
        return () => descriptor.parse(process.env[key]);
      }
      function L3(registry, parent) {
        const target = {};
        for (const [key, descriptor] of false ? [] : Object.entries(registry)) {
          Object.defineProperty(target, key, { get: _t(key, descriptor), enumerable: true });
        }
        return target;
      }
      const W = {};
      Mr(W, {
        CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: () => H.int(),
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: () => H.int({ min: 1 }),
      });
      const MN = { ...W };
      const a = L3(MN, null);
      export { a };
    `,
  ],
  [
    "consumer.js",
    `
      import { a } from "./env-module.js";
      function fileReadLimit() {
        const configured = a.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
        if (configured !== undefined && configured > 0) return configured;
        return;
      }
      const options = { maxTokens: fileReadLimit() ?? 25e3 };
      const toolConcurrency = a.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY ?? 10;
    `,
  ],
]);

const check = (source: string, pins: Readonly<Record<string, string>> = { [bashKey]: "30000" }) =>
  assertClaudeMemorySettings(new Map([["release.js", source]]), pins);

function gcSource(overrides = "") {
  return `
    class TranscriptStore {
      localGcEnabled = false;
      setLocalGcEnabled(value) { this.localGcEnabled = value; }
      requestCompact() {
        if (!this.localGcEnabled) return;
        this.performCompactTranscript();
      }
      performCompactTranscript() {}
    }
    const transcriptStore = new TranscriptStore();
    if (process.env.${gcKey} === "1") transcriptStore.setLocalGcEnabled(true);
    ${overrides}
  `;
}

describe("Claude native memory setting release guard", () => {
  it("proves the three defaults through the pinned process and `a` settings paths", () => {
    const parser = `
      function qje(name, value, fallback, upper) {
        if (!value) return { effective: fallback, status: "valid" };
        const parsed = Number(value);
        if (isNaN(parsed) || parsed <= 0) return { effective: fallback, status: "invalid" };
        if (parsed > upper) return { effective: upper, status: "capped" };
        return { effective: parsed, status: "valid" };
      }
      const bash = qje("${bashKey}", process.env.${bashKey}, 3e4, 150000).effective;
    `;
    expect(
      assertClaudeMemorySettings(
        new Map([["release.js", parser], ...typedSources]),
        defaultPins,
      ).map(({ key, default: value }) => [key, value]),
    ).toEqual([
      [bashKey, "30000"],
      [fileKey, "25000"],
      [concurrencyKey, "10"],
    ]);
  });

  it.each([
    "",
    `const text = "process.env.${bashKey} ?? 30000";`,
    `// process.env.${bashKey} ?? 30000`,
    `function f(process) { return process.env.${bashKey} ?? 30000; }`,
    `process.env.${bashKey} = "30000";`,
    `const process = require(moduleName); process.env.${bashKey} ?? 30000;`,
    `const { env } = require(moduleName); env.${bashKey} ?? 30000;`,
  ])("does not count text, shadowed globals, dynamic require, or writes as reads", (source) => {
    expect(() => check(source)).toThrow(`RELEASE_MEMORY_SETTING_MISSING: ${bashKey}`);
  });

  it("fails closed on safe native aliases outside the pinned package shape", () => {
    expect(() => check(`let env; env = process.env; env.${bashKey} ?? 30000;`)).toThrow(
      `RELEASE_MEMORY_SETTING_MISSING: ${bashKey}`,
    );
  });

  it("fails when the typed settings table is renamed or no longer contains the consumer key", () => {
    const renamed = new Map(typedSources);
    renamed.set(
      "env-module.js",
      typedSources.get("env-module.js")!.replace(fileKey, "RENAMED_FILE_READ_LIMIT"),
    );
    expect(() => assertClaudeMemorySettings(renamed, { [fileKey]: "25000" })).toThrow(
      `RELEASE_MEMORY_SETTING_MISSING: ${fileKey}`,
    );
  });

  it("does not accept a registry entry without a consumer read", () => {
    const registryOnly = new Map(typedSources);
    registryOnly.delete("consumer.js");
    expect(() => assertClaudeMemorySettings(registryOnly, { [fileKey]: "25000" })).toThrow(
      `RELEASE_MEMORY_SETTING_MISSING: ${fileKey}`,
    );
  });

  it("fails closed when a typed integer descriptor adds an unsupported default", () => {
    const changed = new Map(typedSources);
    changed.set(
      "env-module.js",
      typedSources
        .get("env-module.js")!
        .replace(`${fileKey}: () => H.int()`, `${fileKey}: () => H.int({ default: 9 })`),
    );
    expect(() => assertClaudeMemorySettings(changed, { [fileKey]: "25000" })).toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${fileKey}`,
    );
  });

  it("rejects a descriptor range that excludes the pinned concurrency", () => {
    const changed = new Map(typedSources);
    changed.set(
      "env-module.js",
      typedSources
        .get("env-module.js")!
        .replace(
          `${concurrencyKey}: () => H.int({ min: 1 })`,
          `${concurrencyKey}: () => H.int({ min: 11 })`,
        ),
    );
    expect(() => assertClaudeMemorySettings(changed, { [concurrencyKey]: "10" })).toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${concurrencyKey}`,
    );
  });

  it("rejects a fallback returned only by a nested unrelated function", () => {
    expect(() =>
      check(`
      function readLimit() {
        const configured = process.env.${bashKey};
        function unused() { return configured; }
        return undefined;
      }
      const max = readLimit() ?? 30000;
    `),
    ).toThrow(`RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${bashKey}`);
  });

  it("accepts the pinned typed reader and its nullish fallback", () => {
    expect(assertClaudeMemorySettings(typedSources, { [fileKey]: "25000" })).toEqual([
      { key: fileKey, source: "consumer.js", default: "25000" },
    ]);
  });

  it("follows renamed local registry bindings", () => {
    const renamed = new Map(
      [...typedSources].map(([name, source]) => [
        name,
        source.replace(/\b(a|L3|MN|_t)\b/g, (name) => `renamed_${name}`),
      ]),
    );
    expect(
      assertClaudeMemorySettings(renamed, { [fileKey]: "25000", [concurrencyKey]: "10" }),
    ).toHaveLength(2);
  });

  it("fails when a native fallback changes or has no static value", () => {
    expect(() => check(`const limit = process.env.${bashKey} ?? 30001;`)).toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${bashKey}`,
    );
    expect(() => check(`const limit = process.env.${bashKey} ?? getDefault();`)).toThrow(
      `RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${bashKey}`,
    );
  });

  it("rejects a parser cap below the explicit memory pin", () => {
    expect(() =>
      check(`
      function qje(name, value, fallback, upper) {
        if (!value) return { effective: fallback };
        if (Number(value) > upper) return { effective: upper };
        return { effective: Number(value) };
      }
      const max = qje("${bashKey}", process.env.${bashKey}, 30000, 20000).effective;
    `),
    ).toThrow(`RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${bashKey}`);
  });

  it("accepts the synthetic explicit GC path used by the native builder", () => {
    expect(
      assertClaudeMemorySettings(new Map([["release.js", gcSource()]]), retentionPins),
    ).toEqual([{ key: gcKey, source: "release.js", mode: "retention", explicitValue: "1" }]);
  });

  it("follows the GC receiver after its local class and instance are renamed", () => {
    const renamed = gcSource()
      .replaceAll("TranscriptStore", "RenamedStore")
      .replaceAll("transcriptStore", "renamedStore");
    expect(assertClaudeMemorySettings(new Map([["release.js", renamed]]), retentionPins)).toEqual([
      { key: gcKey, source: "release.js", mode: "retention", explicitValue: "1" },
    ]);
  });

  it("fails for missing, renamed, disabled, ignored, or ungated GC settings", () => {
    expect(() =>
      assertClaudeMemorySettings(new Map([["release.js", "// GC absent"]]), retentionPins),
    ).toThrow(`RELEASE_MEMORY_SETTING_MISSING: ${gcKey}`);
    expect(() =>
      assertClaudeMemorySettings(
        new Map([["release.js", gcSource().replace(gcKey, "RENAMED_GC")]]),
        retentionPins,
      ),
    ).toThrow(`RELEASE_MEMORY_SETTING_MISSING: ${gcKey}`);
    expect(() =>
      assertClaudeMemorySettings(
        new Map([["release.js", gcSource().replace(`=== "1"`, `=== "0"`)]]),
        retentionPins,
      ),
    ).toThrow(`RELEASE_MEMORY_SETTING_RETENTION_UNPROVEN: ${gcKey}`);
    expect(() =>
      assertClaudeMemorySettings(
        new Map([
          [
            "release.js",
            gcSource().replace("this.localGcEnabled = value", "this.localGcEnabled = false"),
          ],
        ]),
        retentionPins,
      ),
    ).toThrow(`RELEASE_MEMORY_SETTING_RETENTION_UNPROVEN: ${gcKey}`);
    const disconnectedSetter = gcSource()
      .replace(
        "class TranscriptStore {",
        "class Decoy { setLocalGcEnabled(value){this.localGcEnabled=value;} }\n    class TranscriptStore {",
      )
      .replace("      setLocalGcEnabled(value) { this.localGcEnabled = value; }", "");
    expect(() =>
      assertClaudeMemorySettings(new Map([["release.js", disconnectedSetter]]), retentionPins),
    ).toThrow(`RELEASE_MEMORY_SETTING_RETENTION_UNPROVEN: ${gcKey}`);
    expect(() =>
      assertClaudeMemorySettings(
        new Map([
          [
            "release.js",
            gcSource().replace(
              "setLocalGcEnabled(value) { this.localGcEnabled = value; }",
              "setLocalGcEnabled(value) { if (value) this.localGcEnabled = value; }",
            ),
          ],
        ]),
        retentionPins,
      ),
    ).toThrow(`RELEASE_MEMORY_SETTING_RETENTION_UNPROVEN: ${gcKey}`);
    expect(() =>
      assertClaudeMemorySettings(
        new Map([
          [
            "release.js",
            gcSource().replace(
              "if (!this.localGcEnabled) return;",
              "if (this.localGcEnabled) return;",
            ),
          ],
        ]),
        retentionPins,
      ),
    ).toThrow(`RELEASE_MEMORY_SETTING_RETENTION_UNPROVEN: ${gcKey}`);
  });
});
