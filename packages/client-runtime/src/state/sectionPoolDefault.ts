/**
 * signalbox: section pool defaults. A section may name the pool its projects'
 * new threads run on. The pool chain is the project's own default model, then
 * the nearest section with a pool, then whatever the thread would otherwise
 * start on (environment default, carried or sticky model); this module is the
 * section step.
 */
import type { ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import { hubInstancePoolId } from "@t3tools/contracts/accountHub";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";

/** The pool of the project's nearest section that names one, or null. */
export function sectionDefaultPoolId(
  snapshot: SectionsSnapshot | null,
  projectId: ProjectId | null,
): string | null {
  if (snapshot === null || projectId === null) return null;
  const byId = new Map(snapshot.sections.map((section) => [section.id, section]));
  let sectionId =
    snapshot.projectPlacements.find((placement) => placement.projectId === projectId)?.sectionId ??
    null;
  // Bounded by the section count, so a corrupt cycle can't spin.
  for (let step = 0; sectionId !== null && step < snapshot.sections.length; step += 1) {
    const section = byId.get(sectionId);
    if (!section) return null;
    if (section.defaultPoolId) return section.defaultPoolId;
    sectionId = section.parentId;
  }
  return null;
}

/** Whether a provider can take a new thread now. */
const usable = (provider: ServerProvider) =>
  provider.enabled &&
  provider.installed &&
  provider.availability !== "unavailable" &&
  provider.auth.status !== "unauthenticated";

/** The provider's default model, preferring built-in models over custom ones. */
const defaultModel = (provider: ServerProvider) =>
  (
    provider.models.find((model) => model.isDefault && !model.isCustom) ??
    provider.models.find((model) => !model.isCustom) ??
    provider.models[0]
  )?.slug;

/**
 * `selection` moved onto the pool: the pool's provider of the same kind with
 * the same model and options, else its first usable provider and that
 * provider's default model. Null when the pool has no usable provider.
 */
export function modelSelectionOnPool(input: {
  readonly selection: ModelSelection | null;
  readonly poolId: string;
  readonly providerInstances: Readonly<Record<string, { readonly config?: unknown }>>;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const candidates = input.providers.filter(
    (provider) =>
      usable(provider) &&
      hubInstancePoolId(input.providerInstances[provider.instanceId]?.config) === input.poolId,
  );
  const selection = input.selection;
  if (selection && candidates.some((provider) => provider.instanceId === selection.instanceId)) {
    return selection;
  }
  const current = selection
    ? input.providers.find((provider) => provider.instanceId === selection.instanceId)
    : undefined;
  const sameKind = current && candidates.find((provider) => provider.driver === current.driver);
  if (selection && sameKind) {
    const offersModel =
      sameKind.models.length === 0 ||
      sameKind.models.some((model) => model.slug === selection.model);
    if (offersModel) return { ...selection, instanceId: sameKind.instanceId };
  }
  const target = sameKind ?? candidates[0];
  const model = target && defaultModel(target);
  return target && model ? { instanceId: target.instanceId, model } : null;
}

/**
 * The section step of a new thread's pool: `selection`, the model the thread
 * would otherwise start on, moved onto the pool of the project's nearest
 * section. Null when the step doesn't apply: the project set its own default
 * model, no section names a pool, or the pool has nothing usable.
 */
export function sectionPoolModelSelection(input: {
  readonly selection: ModelSelection | null;
  readonly resolved: Pick<ResolvedProjectSettings, "settings" | "sources">;
  readonly snapshot: SectionsSnapshot | null;
  readonly projectId: ProjectId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const { settings, sources } = input.resolved;
  if (sources.defaultModelSelection === "project" && settings.defaultModelSelection !== null) {
    return null;
  }
  const poolId = sectionDefaultPoolId(input.snapshot, input.projectId);
  if (poolId === null) return null;
  return modelSelectionOnPool({
    selection: input.selection,
    poolId,
    providerInstances: settings.providerInstances,
    providers: input.providers,
  });
}
