/**
 * Automations and mapped places as `LeveledThing`s, for the agent page's
 * Access view. Their folders come from the same index as the Home tree: a
 * place's levels are its home plus every folder that references it (you put
 * it there, so that folder's agent may use it), and its reach says whether
 * folders inside those may too. Accounts are left out: Plugins already lists
 * them as connections.
 */
import { useMemo } from "react";

import { useAutomations } from "../homeAutomations/runDecisions";
import { buildMappedIndex, useMappedStore } from "../sidebar/sections/mappedItems";
import { useProjects } from "../../state/entities";
import type { LeveledThing } from "./leveledThings";

export function useMappedLeveledThings(): readonly LeveledThing[] {
  const automations = useAutomations();
  const projects = useProjects();
  const homes = useMappedStore((state) => state.homes);
  const references = useMappedStore((state) => state.references);
  const reach = useMappedStore((state) => state.reach);
  return useMemo(() => {
    const index = buildMappedIndex({
      automations,
      projects: projects.map((project) => ({
        projectKey: `${project.environmentId}:${project.id}`,
        displayName: project.title,
        workspaceRoot: project.workspaceRoot,
      })),
      overrides: { homes, references, reach },
    });
    const seen = new Set<string>();
    const things: LeveledThing[] = [];
    for (const items of index.byContainer.values()) {
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const levels = index.homesById.get(item.id) ?? [];
        if (item.kind === "automation") {
          things.push({
            key: item.id,
            kind: "automations",
            name: item.title,
            detail: item.automation.cadence,
            levels,
          });
        } else if (item.kind === "place") {
          things.push({
            key: item.id,
            kind: "places",
            name: item.title,
            detail: item.mapping.what,
            levels,
            reach: index.reachById.get(item.id) ?? "here",
          });
        }
      }
    }
    return things;
  }, [automations, homes, projects, reach, references]);
}
