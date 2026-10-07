/**
 * signalbox: section pool defaults. A section may name the pool its projects'
 * new threads run on. The pool chain is composer choice, then the project's
 * own default model, then the nearest section with a pool, then the
 * environment default; this module is the section step.
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

/**
 * `selection` moved onto the pool: the pool's provider of the same kind with
 * the same model and options, else its first usable provider and that
 * provider's default model. Unchanged when the pool has no usable provider.
 */
export function modelSelectionOnPool(input: {
  readonly selection: ModelSelection | null;
  readonly poolId: string;
  readonly providerInstances: Readonly<Record<string, { readonly config?: unknown }>>;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const candidates = input.providers.filter(
    (provider) =>
      provider.enabled &&
      provider.availability !== "unavailable" &&
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
  const model = target?.models.find((entry) => entry.isDefault) ?? target?.models[0];
  return target && model ? { instanceId: target.instanceId, model: model.slug } : selection;
}

/**
 * The default model for a new thread in a project: the project's own default
 * when it set one, else the environment default moved onto the pool of the
 * project's nearest section, when one names a pool.
 */
export function projectDefaultModelSelectionWithSectionPool(input: {
  readonly resolved: Pick<ResolvedProjectSettings, "settings" | "sources">;
  readonly snapshot: SectionsSnapshot | null;
  readonly projectId: ProjectId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const selection = input.resolved.settings.defaultModelSelection;
  if (input.resolved.sources.defaultModelSelection === "project" && selection !== null) {
    return selection;
  }
  const poolId = sectionDefaultPoolId(input.snapshot, input.projectId);
  if (poolId === null) return selection;
  return modelSelectionOnPool({
    selection,
    poolId,
    providerInstances: input.resolved.settings.providerInstances,
    providers: input.providers,
  });
}
