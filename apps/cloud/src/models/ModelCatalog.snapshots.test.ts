import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { poolSourceId } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { PoolEntry } from "../pool/poolViews.ts";
import * as ModelCatalog from "./ModelCatalog.ts";
import * as ModelManifest from "./ModelManifest.ts";

const checkedAt = "2026-10-16T00:00:00.000Z";
const account = {
  id: "account",
  driver: ProviderDriverKind.make("codex"),
  usageLimits: { checkedAt, windows: [] },
};
const entry = (
  id: string,
  model: string,
  accounts: PoolEntry["source"]["accounts"],
  error?: string,
): PoolEntry => ({
  pool: {
    id,
    objectName: `owner:${id}`,
    name: id,
    personal: id === "personal",
    backing: { mode: "managed" },
  },
  source: {
    id: poolSourceId(id),
    kind: "cliproxy",
    label: id,
    checkedAt,
    accounts,
    ...(error === undefined ? {} : { error }),
  },
  models: [{ id: model, ownedBy: "openai", created: 0 }],
  role: "admin",
  routing: null,
});
const layer = ModelCatalog.layer.pipe(
  Layer.provide(
    Layer.succeed(ModelManifest.ModelManifest, {
      current: Effect.succeed({
        version: 1,
        providers: {
          codex: {
            profiles: {},
            models: [
              { slug: "cached-model", name: "Cached", defaultSelection: "economical" },
              { slug: "ready-model", name: "Ready", defaultSelection: "economical" },
            ],
          },
        },
      }),
    }),
  ),
);
const view = (pools: ReadonlyArray<PoolEntry>) =>
  Effect.gen(function* () {
    const catalog = yield* ModelCatalog.ModelCatalog;
    return yield* catalog.view({ pools, checkedAt });
  }).pipe(Effect.provide(layer));

describe("ModelCatalog snapshot recovery", () => {
  it.effect.each([false, true])("prefers a ready pool when signedIn is %s", (signedIn) =>
    Effect.gen(function* () {
      const stale = entry(
        "personal",
        "cached-model",
        signedIn ? [account] : [],
        "Pool status is taking too long to refresh.",
      );
      const ready = entry("work", "ready-model", [account]);
      const catalog = yield* view([stale, ready]);
      expect(
        catalog.providers.find((provider) => provider.instanceId === "codex_hub"),
      ).toMatchObject({
        status: signedIn ? "warning" : "error",
        auth: { status: signedIn ? "authenticated" : "unknown" },
        models: [{ slug: "cached-model" }],
      });
      expect(catalog.defaultModelSelection).toEqual({
        instanceId: ProviderInstanceId.make("codex_hub_work"),
        model: "ready-model",
      });
      expect((yield* view([stale])).defaultModelSelection).toEqual({
        instanceId: ProviderInstanceId.make("codex_hub"),
        model: "cached-model",
      });
    }),
  );
  it.effect.each([{ signedOut: true }, { disabled: true }])(
    "does not revive inactive accounts through an errored snapshot %o",
    (inactive) =>
      Effect.gen(function* () {
        const catalog = yield* view([
          entry(
            "personal",
            "cached-model",
            [{ ...account, ...inactive }],
            "Pool did not refresh in time.",
          ),
        ]);
        expect(
          catalog.providers.find((provider) => provider.instanceId === "codex_hub"),
        ).toMatchObject({
          auth: { status: "unauthenticated" },
          models: [],
        });
        expect(catalog.defaultModelSelection).toBeNull();
      }),
  );
});
