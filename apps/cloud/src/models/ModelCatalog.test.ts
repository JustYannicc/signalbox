import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { POOL_INSTANCE_KINDS, poolSourceId } from "@t3tools/contracts/accountHub";
import type { ModelManifestCatalogs } from "@t3tools/shared/modelManifest";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { PoolEntry } from "../pool/poolViews.ts";
import * as ModelCatalog from "./ModelCatalog.ts";
import * as ModelManifest from "./ModelManifest.ts";

const checkedAt = "2026-10-16T00:00:00.000Z";
const readError = "The pool is unavailable right now. Try again.";

const account = (kind: "claude" | "codex"): PoolEntry["source"]["accounts"][number] => ({
  id: `${kind}-account`,
  driver: POOL_INSTANCE_KINDS[kind].driver,
  usageLimits: { checkedAt, windows: [] },
});

const poolEntry = (
  input: {
    readonly id?: string;
    readonly name?: string;
    readonly personal?: boolean;
    readonly accounts?: PoolEntry["source"]["accounts"];
    readonly models?: PoolEntry["models"];
    readonly error?: string;
  } = {},
): PoolEntry => {
  const id = input.id ?? "personal";
  const name = input.name ?? (id === "personal" ? "Personal" : id);
  return {
    pool: {
      id,
      objectName: `owner:${id}`,
      name,
      personal: input.personal ?? id === "personal",
      backing: { mode: "managed" },
    },
    source: {
      id: poolSourceId(id),
      kind: "cliproxy",
      label: name,
      checkedAt,
      accounts: input.accounts ?? [account("claude"), account("codex")],
      ...(input.error === undefined ? {} : { error: input.error }),
    },
    models: input.models ?? [],
    role: "admin",
    routing: null,
  };
};

const catalogLayer = (catalogs: ModelManifestCatalogs = ModelManifest.BUNDLED_MODEL_CATALOGS) =>
  ModelCatalog.layer.pipe(
    Layer.provide(
      Layer.succeed(ModelManifest.ModelManifest, { current: Effect.succeed(catalogs) }),
    ),
  );

const view = (pools: ReadonlyArray<PoolEntry>, catalogs?: ModelManifestCatalogs) =>
  Effect.gen(function* () {
    const models = yield* ModelCatalog.ModelCatalog;
    return yield* models.view({ pools, checkedAt });
  }).pipe(Effect.provide(catalogLayer(catalogs)));

const initialSelection = (
  pools: ReadonlyArray<PoolEntry>,
  poolId: string | null,
  personDefault: Parameters<
    ModelCatalog.ModelCatalog["Service"]["initialSelection"]
  >[0]["personDefault"],
  catalogs?: ModelManifestCatalogs,
) =>
  Effect.gen(function* () {
    const models = yield* ModelCatalog.ModelCatalog;
    return yield* models.initialSelection({ pools, checkedAt, poolId, personDefault });
  }).pipe(Effect.provide(catalogLayer(catalogs)));

const provider = (providers: ReadonlyArray<ServerProvider>, id: string) =>
  providers.find((candidate) => candidate.instanceId === ProviderInstanceId.make(id));

const served = (ownedBy: string, ...ids: ReadonlyArray<string>) =>
  ids.map((id) => ({ id, ownedBy, created: 1_790_000_000 }));

describe("ModelCatalog public entry point", () => {
  it.effect("uses served models in manifest order with fallback names and a pool default", () =>
    Effect.gen(function* () {
      const manifest: ModelManifestCatalogs = {
        ...ModelManifest.BUNDLED_MODEL_CATALOGS,
        providers: {
          ...ModelManifest.BUNDLED_MODEL_CATALOGS.providers,
          claudeAgent: {
            ...ModelManifest.BUNDLED_MODEL_CATALOGS.providers?.claudeAgent,
            profiles: ModelManifest.BUNDLED_MODEL_CATALOGS.providers?.claudeAgent?.profiles ?? {},
            models: [
              ...(ModelManifest.BUNDLED_MODEL_CATALOGS.providers?.claudeAgent?.models ?? []),
              {
                slug: "claude-opus-5",
                name: "Claude Opus 5 legacy",
                status: "legacy",
                defaultSelection: "excluded",
              },
            ],
          },
        },
      };
      const catalog = yield* view(
        [
          poolEntry({
            models: [
              ...served(
                "anthropic",
                "claude-fable-5-1",
                "claude-sonnet-5-5",
                "claude-opus-5-5",
                "claude-opus-5",
                "claude-zephyr-6",
                "claude-dawn",
              ),
              ...served("openai", "gpt-6.1-sol"),
            ],
          }),
        ],
        manifest,
      );
      const claude = provider(catalog.providers, "claude_hub");

      expect(
        claude?.models.map((model) => [model.slug, model.name, model.isDefault ?? false]),
      ).toEqual([
        ["claude-opus-5-5", "Claude Opus 5.5", false],
        ["claude-sonnet-5-5", "Claude Sonnet 5.5", true],
        ["claude-fable-5-1", "Claude Fable 5.1", false],
        ["claude-opus-5", "Claude Opus 5 legacy", false],
        ["claude-dawn", "claude-dawn", false],
        ["claude-zephyr-6", "claude-zephyr-6", false],
      ]);
      expect(claude?.models.find((model) => model.slug === "claude-opus-5")).toMatchObject({
        isLegacy: true,
      });
      expect(catalog.defaultModelSelection).toEqual({
        instanceId: ProviderInstanceId.make("claude_hub"),
        model: "claude-sonnet-5-5",
      });
    }),
  );

  it.effect(
    "uses maintained pricing for defaults and never advertises an unserved manifest model",
    () =>
      Effect.gen(function* () {
        const manifest: ModelManifestCatalogs = {
          version: 1,
          providers: {
            codex: {
              defaults: { chat: "flagship" },
              profiles: {},
              models: [
                {
                  slug: "flagship",
                  name: "Flagship",
                  status: "current",
                  defaultSelection: "excluded",
                  pricing: { inputCostPerMillionTokens: 20, outputCostPerMillionTokens: 100 },
                },
                {
                  slug: "new-economy",
                  name: "New economy",
                  status: "current",
                  pricing: { inputCostPerMillionTokens: 0.1, outputCostPerMillionTokens: 0.2 },
                },
                {
                  slug: "balanced",
                  name: "Balanced",
                  status: "current",
                  pricing: { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 },
                },
                { slug: "manifest-only", name: "Not served", status: "current" },
              ],
            },
          },
        };
        const catalog = yield* view(
          [
            poolEntry({
              accounts: [account("codex")],
              models: [
                ...served("openai", "balanced", "flagship", "new-economy"),
                ...served("openai", "unlisted"),
              ],
            }),
          ],
          manifest,
        );
        const codex = provider(catalog.providers, "codex_hub");

        expect(codex?.models.map((model) => model.slug)).toEqual([
          "flagship",
          "new-economy",
          "balanced",
          "unlisted",
        ]);
        expect(codex?.models.find((model) => model.slug === "unlisted")).toMatchObject({
          name: "unlisted",
          capabilities: null,
        });
        expect(codex?.models.find((model) => model.slug === "new-economy")).toMatchObject({
          name: "New economy",
          isDefault: true,
          pricing: { inputCostPerMillionTokens: 0.1, outputCostPerMillionTokens: 0.2 },
        });
        expect(catalog.defaultModelSelection).toEqual({
          instanceId: ProviderInstanceId.make("codex_hub"),
          model: "new-economy",
        });
        expect(catalog.instances).toHaveProperty("codex_hub");
      }),
  );

  it.effect("maps current pool names and reasoning options while retaining Claude fast mode", () =>
    Effect.gen(function* () {
      const catalog = yield* view([
        poolEntry({
          models: [
            {
              id: "claude-opus-5-5",
              ownedBy: "anthropic",
              created: 1,
              reasoningEfforts: ["low", "high"],
            },
            {
              id: "new-research-model",
              ownedBy: "openai",
              created: 1,
              displayName: "New research model",
              reasoningEfforts: ["low", "medium", "future-effort"],
            },
          ],
        }),
      ]);
      const claude = provider(catalog.providers, "claude_hub")?.models[0];
      const codex = provider(catalog.providers, "codex_hub")?.models[0];

      expect(claude).toMatchObject({
        name: "Claude Opus 5.5",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              currentValue: "low",
              options: [{ id: "low", isDefault: true }, { id: "high" }],
            },
            { id: "fastMode", label: "Fast Mode", type: "boolean" },
          ],
        },
      });
      expect(codex).toMatchObject({
        name: "New research model",
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              currentValue: "medium",
              options: [
                { id: "low" },
                { id: "medium", isDefault: true },
                { id: "future-effort", label: "future-effort" },
              ],
            },
          ],
        },
      });
    }),
  );

  it.effect(
    "keeps cached models usable through a pool error and exposes unreadable pools as unknown",
    () =>
      Effect.gen(function* () {
        const cached = poolEntry({
          id: "cached",
          accounts: [account("claude")],
          models: served("anthropic", "claude-sonnet-5-5"),
          error: readError,
        });
        const unreadable = poolEntry({ id: "unreadable", accounts: [], error: readError });
        const catalog = yield* view([cached, unreadable]);
        const cachedProvider = provider(catalog.providers, "claude_hub_cached");
        const unreadableProvider = provider(catalog.providers, "claude_hub_unreadable");

        expect(cachedProvider).toMatchObject({
          status: "warning",
          auth: { status: "authenticated" },
          message: readError,
          unavailableReason: readError,
          models: [{ slug: "claude-sonnet-5-5" }],
        });
        expect(unreadableProvider).toMatchObject({
          status: "error",
          auth: { status: "unknown" },
          message: readError,
          models: [],
        });
        expect(yield* initialSelection([cached], "cached", null)).toEqual({
          instanceId: ProviderInstanceId.make("claude_hub_cached"),
          model: "claude-sonnet-5-5",
        });
        expect(yield* initialSelection([unreadable], "unreadable", null)).toBeNull();
      }),
  );

  it.effect(
    "has no providers, instances, or invented initial model when the user has no pools",
    () =>
      Effect.gen(function* () {
        const catalog = yield* view([]);
        const emptyPoolCatalog = yield* view([poolEntry({ id: "empty", models: [] })]);
        const signedOutPoolCatalog = yield* view([
          poolEntry({ id: "signed-out", accounts: [], models: served("openai", "gpt-6-luna") }),
        ]);

        expect(catalog.providers).toEqual([]);
        expect(catalog.instances).toEqual({});
        expect(catalog.defaultModelSelection).toBeNull();
        expect(yield* initialSelection([], null, null)).toBeNull();
        expect(provider(emptyPoolCatalog.providers, "claude_hub_empty")?.models).toEqual([]);
        expect(emptyPoolCatalog.defaultModelSelection).toBeNull();
        expect(provider(signedOutPoolCatalog.providers, "codex_hub_signed-out")).toMatchObject({
          auth: { status: "unauthenticated" },
          models: [],
        });
        expect(signedOutPoolCatalog.defaultModelSelection).toBeNull();
      }),
  );

  it.effect(
    "remaps supported person defaults, preserving aliases and options, without changing catalog defaults",
    () =>
      Effect.gen(function* () {
        const manifest: ModelManifestCatalogs = {
          version: 1,
          providers: {
            claudeAgent: {
              defaults: { chat: "claude-sonnet-5-5" },
              profiles: {},
              models: [
                {
                  slug: "claude-sonnet-5-5",
                  name: "Sonnet",
                  aliases: ["sonnet"],
                  status: "current",
                  defaultSelection: "economical",
                },
                {
                  slug: "claude-fable-5-1",
                  name: "Fable",
                  status: "current",
                  defaultSelection: "excluded",
                },
              ],
            },
          },
        };
        const pools = [
          poolEntry({ models: served("anthropic", "claude-sonnet-5-5", "claude-fable-5-1") }),
          poolEntry({
            id: "work",
            personal: false,
            models: served("anthropic", "claude-sonnet-5-5", "claude-fable-5-1"),
          }),
        ];
        const catalog = yield* view(pools, manifest);
        const selection = yield* initialSelection(
          pools,
          "work",
          {
            instanceId: ProviderInstanceId.make("claude_hub"),
            model: "sonnet",
            options: [{ id: "effort", value: "high" }],
          },
          manifest,
        );

        expect(catalog.defaultModelSelection).toEqual({
          instanceId: ProviderInstanceId.make("claude_hub"),
          model: "claude-sonnet-5-5",
        });
        expect(selection).toEqual({
          instanceId: ProviderInstanceId.make("claude_hub_work"),
          model: "sonnet",
          options: [{ id: "effort", value: "high" }],
        });
        expect(
          yield* initialSelection(
            [poolEntry({ models: served("anthropic", "claude-fable-5-1") })],
            "personal",
            null,
          ),
        ).toBeNull();
      }),
  );
});
