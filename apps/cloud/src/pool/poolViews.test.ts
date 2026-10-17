import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { poolSourceId } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "@effect/vitest";

import { poolServerProvider } from "../thread/providerCatalog.ts";
import type { PoolEntry } from "./poolViews.ts";
import {
  poolDefaultModelSelection,
  poolFallbackModelSelection,
  poolProviders,
  modelsForSnapshot,
} from "./poolViews.ts";

const provider = (signedIn: boolean) =>
  poolServerProvider({
    kind: "codex",
    instanceId: ProviderInstanceId.make("personal-codex"),
    displayName: "Personal",
    signedIn,
    models: [],
    checkedAt: "2026-10-16T00:00:00.000Z",
  });

const poolEntry = (source: PoolEntry["source"], models: PoolEntry["models"]): PoolEntry => ({
  pool: {
    id: "personal",
    objectName: "owner:personal",
    name: "Personal",
    personal: true,
    backing: { mode: "managed" },
  },
  source,
  models,
  role: "admin",
  routing: null,
});

describe("poolFallbackModelSelection", () => {
  it.each([
    ["error", "unknown"],
    ["warning", "authenticated"],
  ] as const)("prefers a ready pool over a %s snapshot when choosing a default", (status, auth) => {
    const stale = {
      ...provider(true),
      status,
      auth: { status: auth },
      models: [{ slug: "cached-model", name: "Cached", isCustom: false, capabilities: null }],
    };
    const ready = {
      ...provider(true),
      status: "ready" as const,
      instanceId: ProviderInstanceId.make("work-codex"),
      models: [{ slug: "ready-model", name: "Ready", isCustom: false, capabilities: null }],
    };
    expect(poolDefaultModelSelection([stale, ready])).toEqual({
      instanceId: ready.instanceId,
      model: "ready-model",
    });
    expect(poolDefaultModelSelection([stale])).toEqual({
      instanceId: stale.instanceId,
      model: "cached-model",
    });
  });

  it("does not revive signed-out or paused accounts in an errored or retained snapshot", () => {
    const checkedAt = "2026-10-16T00:00:00.000Z";
    const models = [{ id: "gpt-6-astra", ownedBy: "openai", created: 0 }];
    for (const inactive of [{ signedOut: true }, { disabled: true }]) {
      const entry = poolEntry(
        {
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
        models,
      );
      expect(modelsForSnapshot(entry)).toEqual([]);
      const providers = poolProviders(
        [
          {
            ...entry,
            source: {
              ...entry.source,
              error: "The pool did not refresh in time.",
            },
          },
        ],
        checkedAt,
        { version: 1 },
      );
      expect(providers.find((candidate) => candidate.driver === "codex")).toMatchObject({
        auth: { status: "unauthenticated" },
        models: [],
      });
      expect(poolDefaultModelSelection(providers)).toBeNull();
    }
  });

  it("never invents a model when the pool has no served models", () => {
    const providers = [provider(false)];
    expect(poolDefaultModelSelection(providers)).toBeNull();
    expect(poolFallbackModelSelection(providers)).toBeNull();
  });

  it("uses a listed model when the provider is temporarily unavailable", () => {
    expect(
      poolFallbackModelSelection([
        {
          ...provider(true),
          models: [{ slug: "new-model", name: "New model", isCustom: false, capabilities: null }],
        },
      ]),
    ).toEqual({ instanceId: "personal-codex", model: "new-model" });
  });

  it("has nothing to name without a pool", () => {
    expect(poolFallbackModelSelection([])).toBeNull();
  });

  it("reports an unreadable accounts snapshot without claiming the pool is signed out", () => {
    const checkedAt = "2026-10-16T00:00:00.000Z";
    const error = "The pool is unavailable right now. Try again.";
    const providers = poolProviders(
      [
        poolEntry(
          {
            id: poolSourceId("personal"),
            kind: "cliproxy",
            label: "Personal",
            checkedAt,
            accounts: [],
            error,
          },
          [],
        ),
      ],
      checkedAt,
      { version: 1 },
    );

    expect(providers.find((candidate) => candidate.driver === "codex")).toMatchObject({
      status: "error",
      auth: { status: "unknown" },
      message: error,
      unavailableReason: error,
      models: [],
    });
    expect(poolDefaultModelSelection(providers)).toBeNull();
    expect(poolFallbackModelSelection(providers)).toBeNull();
  });

  it("keeps cached accounts and models usable when the latest pool read failed", () => {
    const checkedAt = "2026-10-16T00:00:00.000Z";
    const error = "The pool is unavailable right now. Try again.";
    const providers = poolProviders(
      [
        poolEntry(
          {
            id: poolSourceId("personal"),
            kind: "cliproxy",
            label: "Personal",
            checkedAt,
            accounts: [
              {
                id: "account",
                driver: ProviderDriverKind.make("codex"),
                usageLimits: { checkedAt, windows: [] },
              },
            ],
            error,
          },
          [
            {
              id: "gpt-6-astra",
              ownedBy: "openai",
              created: 0,
              displayName: "Astra",
              reasoningEfforts: [],
            },
          ],
        ),
      ],
      checkedAt,
      { version: 1 },
    );
    const codex = providers.find((candidate) => candidate.driver === "codex");

    expect(codex).toMatchObject({
      status: "warning",
      auth: { status: "authenticated" },
      message: error,
      unavailableReason: error,
      models: [{ slug: "gpt-6-astra" }],
    });
  });
});
