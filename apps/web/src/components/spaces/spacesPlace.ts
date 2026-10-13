/**
 * The place /spaces shows, read from its URL: a connected account at the level
 * it is connected at (the items no mapped place covers, or all of them), one
 * mapped place inside an account, or everything in sight. Also where it lives
 * (one home, the folders referencing it, its reach), which the page's
 * breadcrumb and summary read.
 */
import { useMemo } from "react";

import { TOP_LEVEL, type LevelKey, type Reach } from "../levels/levels";
import { useHomeProjectRefs } from "../levels/useHomeProjectRefs";
import {
  accountItemId,
  buildMappedIndex,
  placeItemId,
  useMappedStore,
} from "../sidebar/sections/mappedItems";
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

export interface PlacePlacement {
  /** The one folder it lives in; an unmapped place falls back to its account's. */
  readonly home: LevelKey;
  /** Other folders that reference it; their agents may use it too. */
  readonly references: readonly LevelKey[];
  readonly reach: Reach;
}

const EVERYTHING_PLACEMENT: PlacePlacement = { home: TOP_LEVEL, references: [], reach: "here" };

/**
 * Where the place lives, read from the same index as the Home tree: the
 * breadcrumb names its home even when it was opened from a folder that only
 * references it.
 */
export function usePlacePlacement(place: SpacesPlace): PlacePlacement {
  const projects = useHomeProjectRefs();
  const homes = useMappedStore((state) => state.homes);
  const references = useMappedStore((state) => state.references);
  const reach = useMappedStore((state) => state.reach);
  return useMemo(() => {
    if (place.kind === "everything") return EVERYTHING_PLACEMENT;
    const index = buildMappedIndex({
      automations: [],
      projects,
      overrides: { homes, references, reach },
    });
    const accountId = accountItemId(place.source?.id ?? "");
    const id = place.kind === "account" ? accountId : placeItemId(place.mapping.id);
    const home = index.homeById.get(id) ?? index.homeById.get(accountId) ?? null;
    if (home === null) return EVERYTHING_PLACEMENT;
    return {
      home,
      references: index.referencesById.get(id) ?? [],
      reach: index.reachById.get(id) ?? "here",
    };
  }, [homes, place, projects, reach, references]);
}

/** "Also in terminal-app · available to every folder inside", or null; `labelOf` names folders. */
export function placeSharing(
  placement: PlacePlacement,
  labelOf: (key: LevelKey) => string,
): string | null {
  const name = (key: LevelKey) => labelOf(key).split(" › ").at(-1) ?? key;
  const parts = [
    placement.references.length > 0 ? `Also in ${placement.references.map(name).join(", ")}` : null,
    placement.reach === "below" ? `Available to every folder inside ${name(placement.home)}` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
