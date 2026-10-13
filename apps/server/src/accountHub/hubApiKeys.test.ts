import { describe, expect, it } from "@effect/vitest";
import { parse } from "yaml";

import { apiKeyAccountId, apiKeySections } from "./hubApiKeys.ts";
import { renderOpenCodeConfig } from "./hubOpenCode.ts";

describe("apiKeySections", () => {
  it("carries the keys the hub saved over Signalbox's config rewrite", () => {
    const saved = [
      "config-version: 8",
      "access:",
      "  api-keys:",
      '    - "client"',
      "api-keys:",
      "  claude:",
      "    - name: claude-1",
      "      keys:",
      "        - api-key: sk-ant-api03-test",
      "openai-compatibility:",
      "  - name: openrouter-abc",
      "    base-url: https://openrouter.ai/api/v1",
      "management:",
      '  secret-key: "hashed"',
    ].join("\n");
    expect(parse(apiKeySections(saved))).toEqual({
      "api-keys": { claude: [{ name: "claude-1", keys: [{ "api-key": "sk-ant-api03-test" }] }] },
      "openai-compatibility": [
        { name: "openrouter-abc", "base-url": "https://openrouter.ai/api/v1" },
      ],
    });
  });

  it("drops old-style client keys and unreadable configs", () => {
    expect(apiKeySections('api-keys:\n  - "client"\n')).toBe("");
    expect(apiKeySections("")).toBe("");
    expect(apiKeySections("::: not yaml :::\n  - [")).toBe("");
  });
});

describe("apiKeyAccountId", () => {
  it("is stable, ignores a trailing slash, and never contains the key", () => {
    const id = apiKeyAccountId("codex-api-key", "sk-secret", "https://api.openai.com/v1/");
    expect(id).toBe(apiKeyAccountId("codex-api-key", "sk-secret", "https://api.openai.com/v1"));
    expect(id).not.toContain("sk-secret");
    expect(id).not.toBe(apiKeyAccountId("claude-api-key", "sk-secret", undefined));
  });
});

describe("renderOpenCodeConfig", () => {
  it("lists only the pool, with its models, and keeps the key out of the file", () => {
    const text = renderOpenCodeConfig({
      baseUrl: "http://127.0.0.1:8317",
      name: "Work",
      models: ["claude-opus-5", "gpt-5.5"],
    });
    const config = JSON.parse(text);
    expect(config.enabled_providers).toEqual(["signalbox"]);
    expect(config.provider.signalbox.options).toEqual({
      baseURL: "http://127.0.0.1:8317/v1",
      apiKey: "{env:SIGNALBOX_POOL_KEY}",
    });
    expect(Object.keys(config.provider.signalbox.models)).toEqual(["claude-opus-5", "gpt-5.5"]);
  });
});
