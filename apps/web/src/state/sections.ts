import { createEnvironmentSectionAtoms } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentSectionsState, SectionTree } from "@t3tools/client-runtime/state/sections";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { OrchestrationProjectShell, EnvironmentId } from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";

export interface EnvironmentSectionsView {
  readonly status: EnvironmentSectionsState;
  readonly snapshot: SectionsSnapshot | null;
  readonly tree: SectionTree<OrchestrationProjectShell>;
}

export const environmentSections = createEnvironmentSectionAtoms(connectionAtomRuntime, {
  serverConfigValueAtom: serverEnvironment.configValueAtom,
  projectsAtom: environmentProjects.environmentProjectsAtom,
});

export const environmentSectionTreesAtom = Atom.make((get) => {
  const trees = new Map<EnvironmentId, EnvironmentSectionsView>();
  const catalog = get(environmentCatalog.catalogValueAtom);
  const configs = get(environmentServerConfigsAtom);
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    if (configs.get(environmentId)?.environment.capabilities.sections !== true) continue;
    trees.set(environmentId, {
      status: get(environmentSections.stateAtom(environmentId)),
      snapshot: get(environmentSections.snapshotAtom(environmentId)),
      tree: get(environmentSections.treeAtom(environmentId)),
    });
  }
  return trees;
}).pipe(Atom.withLabel("web-environment-section-trees"));
