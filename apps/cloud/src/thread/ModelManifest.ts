import type { ModelManifestCatalogs } from "@t3tools/shared/modelManifest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Pools own availability and reasoning. This fallback covers labels, defaults and fast mode. */
export const BUNDLED_MODEL_CATALOGS: ModelManifestCatalogs = {
  version: 1,
  providers: {
    claudeAgent: {
      defaults: { chat: "claude-fable-5-1" },
      profiles: {
        opus: {
          capabilities: {
            optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
          },
        },
      },
      models: [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", status: "current", profile: "opus" },
        { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", status: "current" },
        { slug: "claude-fable-5-1", name: "Claude Fable 5.1", status: "current" },
        { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", status: "current" },
      ],
    },
    codex: {
      defaults: { chat: "gpt-6-astra" },
      profiles: {},
      models: [
        { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", status: "current" },
        { slug: "gpt-6-astra", name: "GPT-6 Astra", status: "current" },
        { slug: "gpt-6-luna", name: "GPT-6 Luna", status: "current" },
      ],
    },
  },
};

export class ModelManifest extends Context.Service<
  ModelManifest,
  { readonly current: Effect.Effect<ModelManifestCatalogs> }
>()("@signalbox/cloud/thread/ModelManifest") {}

export const layer = Layer.succeed(
  ModelManifest,
  ModelManifest.of({ current: Effect.succeed(BUNDLED_MODEL_CATALOGS) }),
);

export const layerBundled = layer;
