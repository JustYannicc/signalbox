import { ProviderDriverKind } from "@t3tools/contracts";
import { poolSourceId } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "@effect/vitest";

import { modelsForSnapshot, type PoolEntry } from "./poolViews.ts";

const checkedAt = "2026-10-16T00:00:00.000Z";

describe("modelsForSnapshot", () => {
  it.each([{ signedOut: true }, { disabled: true }])(
    "does not retain models for an inactive account %o",
    (inactive) => {
      const entry: PoolEntry = {
        pool: {
          id: "personal",
          objectName: "owner:personal",
          name: "Personal",
          personal: true,
          backing: { mode: "managed" },
        },
        source: {
          id: poolSourceId("personal"),
          kind: "cliproxy",
          label: "Personal",
          checkedAt,
          accounts: [
            {
              id: "account",
              driver: ProviderDriverKind.make("codex"),
              usageLimits: { checkedAt, windows: [] },
              ...inactive,
            },
          ],
        },
        models: [{ id: "gpt-6-astra", ownedBy: "openai", created: 0 }],
        role: "admin",
        routing: null,
      };
      expect(modelsForSnapshot(entry)).toEqual([]);
    },
  );

  it("keeps registered local models when the pool has no OAuth accounts", () => {
    const local = {
      id: "claude-local-model",
      ownedBy: "anthropic",
      created: null,
      registration: { kind: "local" as const, transportId: "local" },
    };
    const entry: PoolEntry = {
      pool: {
        id: "personal",
        objectName: "owner:personal",
        name: "Personal",
        personal: true,
        backing: { mode: "managed" },
      },
      source: {
        id: poolSourceId("personal"),
        kind: "cliproxy",
        label: "Personal",
        checkedAt,
        accounts: [],
      },
      models: [local],
      role: "admin",
      routing: null,
    };

    expect(modelsForSnapshot(entry)).toEqual([local]);
  });
});
