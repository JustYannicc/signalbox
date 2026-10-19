import { ProviderDriverKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import type {
  ClaudeModelCatalog,
  ClaudeCatalogModel,
} from "@signalbox/provider-claude/ClaudeModelCatalog";
import {
  decodeClaudeModelAdapter,
  decodeClaudeProfileAdapter,
} from "@signalbox/provider-claude/ClaudeModelManifest";
import { BUNDLED_MODEL_MANIFEST, resolveProviderCatalog } from "./ModelManifest.ts";
const CLAUDE = ProviderDriverKind.make("claudeAgent");
function tryResolveClaudeModelCatalog(
  resolved: ModelCatalog.ProviderCatalog | undefined,
): ClaudeModelCatalog | null {
  if (!resolved) return null;

  const models: Array<ClaudeCatalogModel> = [];
  for (const entry of resolved.models) {
    const profile = decodeClaudeProfileAdapter(entry.profileAdapter ?? {});
    const adapter = decodeClaudeModelAdapter(entry.adapter ?? {});
    if (Option.isNone(profile) || Option.isNone(adapter)) return null;
    models.push({
      model: ModelCatalog.catalogServerModel(resolved, entry),
      runtime: profile.value.claudeCode ?? {},
      compatibility: adapter.value.claudeCode ?? {},
    });
  }

  return {
    models,
  };
}

const BUNDLED_CLAUDE_PROVIDER_CATALOG =
  resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, CLAUDE) ?? undefined;

export function resolveClaudeModelCatalog(
  catalog: ModelCatalog.ProviderCatalog | undefined,
): ClaudeModelCatalog {
  return (
    tryResolveClaudeModelCatalog(catalog) ??
    tryResolveClaudeModelCatalog(BUNDLED_CLAUDE_PROVIDER_CATALOG) ?? {
      models: [],
    }
  );
}

export const BUNDLED_CLAUDE_MODEL_CATALOG = resolveClaudeModelCatalog(
  BUNDLED_CLAUDE_PROVIDER_CATALOG,
);
