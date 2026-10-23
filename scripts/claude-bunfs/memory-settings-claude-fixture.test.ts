// @effect-diagnostics nodeBuiltinImport:off - reads the SHA-pinned, immutable release fixture.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { CLAUDE_MEMORY_ENV } from "@t3tools/contracts/harnessMemorySettings";
import { describe, expect, it } from "vite-plus/test";
import { readExtraction } from "./extracted-input.ts";
import { assertClaudeMemorySettings } from "./memory-settings-claude.ts";
import {
  mutateClaudeCallFallback,
  mutateClaudeDirectFallback,
  mutateClaudeParserArgument,
  mutateClaudeTypedDescriptor,
  omitClaudeSettingSources,
  renameClaudeSettingSources,
} from "./memory-settings-claude-mutations.ts";

const fixtureRoot = process.env.CLAUDE_MEMORY_SETTINGS_FIXTURE_ROOT;
const actualFixture = fixtureRoot ? it : it.skip;

async function readPinnedSources() {
  const extraction = await readExtraction(NodePath.join(fixtureRoot!, "extracted"));
  const modules = extraction.manifest.modules.filter((module) => module.loader === 1);
  expect(modules).toHaveLength(2433);
  const sources = new Map<string, string>();
  for (const module of modules) sources.set(module.name, await extraction.readSource(module));
  return sources;
}

function expectMutationFailure(
  sources: ReadonlyMap<string, string>,
  key: string,
  pin: string,
  error: string,
) {
  expect(() => assertClaudeMemorySettings(sources, { [key]: pin })).toThrow(`${error}: ${key}`);
}

describe("Claude pinned release memory source proof", () => {
  actualFixture("pins the unomitted release used by the extracted source map", async () => {
    const raw = await NodeFSP.readFile(NodePath.join(fixtureRoot!, "unomitted-release.js"));
    expect(NodeCrypto.createHash("sha256").update(raw).digest("hex")).toBe(
      "86e0f3676ea87b35e83606776a2bd67a9dd98b74e80d57efcccf8961921bb854",
    );
    for (const setting of Object.keys(CLAUDE_MEMORY_ENV))
      expect(raw.includes(Buffer.from(setting))).toBe(true);
  });

  actualFixture("proves the extracted source map and rejects source mutations", async () => {
    const sources = await readPinnedSources();
    expect(
      assertClaudeMemorySettings(sources, CLAUDE_MEMORY_ENV).map(({ key, default: value }) => [
        key,
        value,
      ]),
    ).toEqual([
      ["BASH_MAX_OUTPUT_LENGTH", "30000"],
      ["CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS", "25000"],
      ["CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY", "10"],
    ]);

    for (const [key, pin] of Object.entries(CLAUDE_MEMORY_ENV)) {
      expectMutationFailure(
        omitClaudeSettingSources(sources, key),
        key,
        pin,
        "RELEASE_MEMORY_SETTING_MISSING",
      );
      expectMutationFailure(
        renameClaudeSettingSources(sources, key),
        key,
        pin,
        "RELEASE_MEMORY_SETTING_MISSING",
      );
      if (key === "BASH_MAX_OUTPUT_LENGTH") {
        expectMutationFailure(
          mutateClaudeParserArgument(sources, key, 2, "30001"),
          key,
          pin,
          "RELEASE_MEMORY_SETTING_DEFAULT_CHANGED",
        );
        expectMutationFailure(
          mutateClaudeParserArgument(sources, key, 3, "20000"),
          key,
          pin,
          "RELEASE_MEMORY_SETTING_DEFAULT_CHANGED",
        );
      } else if (key === "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS") {
        expectMutationFailure(
          mutateClaudeTypedDescriptor(sources, key, "() => H.int({ default: 9 })"),
          key,
          pin,
          "RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN",
        );
        expectMutationFailure(
          mutateClaudeCallFallback(sources, key, 25000, "25001"),
          key,
          pin,
          "RELEASE_MEMORY_SETTING_DEFAULT_CHANGED",
        );
      } else {
        expectMutationFailure(
          mutateClaudeTypedDescriptor(sources, key, "() => H.int({ default: 9 })"),
          key,
          pin,
          "RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN",
        );
        expectMutationFailure(
          mutateClaudeTypedDescriptor(sources, key, "() => H.int({ min: 11 })"),
          key,
          pin,
          "RELEASE_MEMORY_SETTING_DEFAULT_CHANGED",
        );
        expectMutationFailure(
          mutateClaudeDirectFallback(sources, key, Number(pin), "11"),
          key,
          pin,
          "RELEASE_MEMORY_SETTING_DEFAULT_CHANGED",
        );
      }
    }
  });
});
