import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { poolSourceId } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "@effect/vitest";

import { poolServerProvider } from "../thread/providerCatalog.ts";
import type { PoolEntry } from "./poolViews.ts";
import {
  poolDefaultModelSelection,
  poolFallbackModelSelection,
  poolProviders,
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
  it("never invents a model when the pool has no served models", () => {
    const providers = [provider(false)];
    expect(poolDefaultModelSelection(providers)).toBeNull();
    expect(poolFallbackModelSelection(providers)).toBeNull();
  });

  it("uses a cached economical model when the provider is temporarily unavailable", () => {
    expect(
      poolFallbackModelSelection([
        {
          ...provider(true),
          models: [
            {
              slug: "gpt-6-luna",
              name: "Luna",
              defaultSelection: "economical" as const,
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ]),
    ).toEqual({ instanceId: "personal-codex", model: "gpt-6-luna" });
  });

  it("ignores flagship defaults and leaves an expensive-only catalog unselected", () => {
    const expensive = {
      ...provider(true),
      models: [
        {
          slug: "gpt-6-astra",
          name: "Astra",
          isDefault: true,
          isCustom: false,
          capabilities: null,
        },
      ],
    };
    expect(poolDefaultModelSelection([expensive])).toBeNull();
    expect(poolFallbackModelSelection([expensive])).toBeNull();
    const withEconomical = {
      ...expensive,
      models: [
        ...expensive.models,
        {
          slug: "gpt-6-luna",
          name: "Luna",
          defaultSelection: "economical" as const,
          isCustom: false,
          capabilities: null,
        },
      ],
    };
    expect(poolDefaultModelSelection([withEconomical])).toEqual({
      instanceId: "personal-codex",
      model: "gpt-6-luna",
    });
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
