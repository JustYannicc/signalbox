import { describe, expect, it } from "@effect/vitest";

import * as PoolModelDiscovery from "./poolModelDiscovery.ts";

describe("pool model metadata", () => {
  it("matches by model id and channel, and drops blank labels and effort names", () => {
    const served: ReadonlyArray<PoolModelDiscovery.ServedModel> = [
      { id: "shared", ownedBy: "anthropic", created: 1 },
      { id: "shared", ownedBy: "openai", created: 2 },
      { id: "known-empty", ownedBy: "anthropic", created: 3 },
      {
        id: "without-definition",
        ownedBy: "anthropic",
        created: 4,
        provider: "claude",
      },
      { id: "shared", ownedBy: "other", created: 5 },
    ];
    const definitions: ReadonlyArray<PoolModelDiscovery.ModelDefinitions> = [
      {
        channel: "claude",
        models: [
          {
            id: "shared",
            display_name: "  Claude model  ",
            thinking: { levels: [" low ", "", "high"] },
          },
          {
            id: "known-empty",
            display_name: "   ",
            thinking: { levels: ["", "  "] },
          },
        ],
      },
      {
        channel: "codex",
        models: [{ id: "shared", display_name: "GPT model", thinking: { levels: [] } }],
      },
    ];

    expect(PoolModelDiscovery.withMetadata(served, definitions)).toEqual([
      {
        id: "shared",
        ownedBy: "anthropic",
        created: 1,
        provider: "claude",
        displayName: "Claude model",
        reasoningEfforts: ["low", "high"],
      },
      {
        id: "shared",
        ownedBy: "openai",
        created: 2,
        provider: "codex",
        displayName: "GPT model",
        reasoningEfforts: [],
      },
      {
        id: "known-empty",
        ownedBy: "anthropic",
        created: 3,
        provider: "claude",
        reasoningEfforts: [],
      },
      {
        id: "without-definition",
        ownedBy: "anthropic",
        created: 4,
        provider: "claude",
      },
      { id: "shared", ownedBy: "other", created: 5 },
    ]);
  });
});
