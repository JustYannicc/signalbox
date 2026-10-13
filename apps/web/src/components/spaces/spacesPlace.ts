/**
 * The place /spaces shows, read from its URL: a connected account at the level
 * it is connected at (the items no mapped place covers, or all of them), one
 * mapped place inside an account, or everything in sight. Also the folder path
 * the page's breadcrumb reads, `levelLabel › place`.
 */
import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { TOP_LEVEL, levelLabel, type LevelKey } from "../levels/levels";
import {
  accountItemId,
  placeItemId,
  resolveTarget,
  type MappedOverrides,
} from "../sidebar/sections/mappedItems";
import { useHomeSectionStore } from "../sidebar/sections/sectionStore";
import type { SpacesItemFixture, SpacesSourceFixture } from "./spacesFixtures";
import {
  findMapping,
  isLoose,
  mappingCovers,
  mappingHealth,
  type SpacesMapping,
} from "./spacesMappings";
import { describeSync, findSource, type SpacesSearch } from "./spacesModel";

export type SpacesPlace =
  | { readonly kind: "account"; readonly source: SpacesSourceFixture; readonly all: boolean }
  | {
      readonly kind: "mapping";
      readonly mapping: SpacesMapping;
      readonly source: SpacesSourceFixture | undefined;
    }
  | { readonly kind: "everything" };

export function resolvePlace(search: SpacesSearch): SpacesPlace {
  const source = findSource(search.account);
  if (source) return { kind: "account", source, all: search.all === true };
  const mapping = findMapping(search.mapping);
  if (mapping) return { kind: "mapping", mapping, source: findSource(mapping.source) };
  return { kind: "everything" };
}

/** Whether an item shows on the place's page; `mappings` are the ones still in a folder. */
export function inPlace(
  place: SpacesPlace,
  item: SpacesItemFixture,
  mappings: readonly SpacesMapping[],
): boolean {
  switch (place.kind) {
    case "account":
      return item.source === place.source.id && (place.all || isLoose(item, mappings));
    case "mapping":
      return mappingCovers(place.mapping, item);
    case "everything":
      return true;
  }
}

export function placeTitle(place: SpacesPlace): string {
  switch (place.kind) {
    case "account":
      return place.source.name;
    case "mapping":
      return place.mapping.name;
    case "everything":
      return "Everything";
  }
}

const countLabel = (count: number) => `${count} ${count === 1 ? "item" : "items"}`;

/** The line under the title; `accountTotal` is every item in the account. */
export function placeSummary(place: SpacesPlace, shown: number, accountTotal: number): string {
  switch (place.kind) {
    case "account": {
      const sync = describeSync(place.source);
      return place.all || shown === accountTotal
        ? `${countLabel(shown)} · ${sync}`
        : `${countLabel(shown)} not in a mapped place · ${sync}`;
    }
    case "mapping":
      return `${place.mapping.what} in ${mappingHealth(place.mapping).accountName} · ${countLabel(shown)}`;
    case "everything":
      return countLabel(shown);
  }
}

/** The level the place sits at: the folder it was opened from, else its home. */
export function placeLevel(
  place: SpacesPlace,
  at: string | undefined,
  homeOverrides: MappedOverrides["homes"],
): LevelKey {
  if (at) return at;
  switch (place.kind) {
    case "account":
      return homeOverrides[accountItemId(place.source.id)] ?? `section:${place.source.space}`;
    case "mapping":
      return homeOverrides[placeItemId(place.mapping.id)] ?? resolveTarget(place.mapping.home, []);
    case "everything":
      return TOP_LEVEL;
  }
}

/** `levelLabel`, with the name of a real project (renamed or as grouped in the sidebar). */
export function useLevelLabel(level: LevelKey): string {
  const renamed = useHomeSectionStore((state) => state.names[level]);
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectName = useMemo(() => {
    if (!level.startsWith("project:")) return undefined;
    const projectKey = level.slice(8);
    return buildSidebarProjectSnapshots({
      projects,
      settings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    }).find((group) => group.projectKey === projectKey)?.displayName;
  }, [level, primaryEnvironmentId, projects, settings]);
  return levelLabel(level, renamed ?? projectName);
}
