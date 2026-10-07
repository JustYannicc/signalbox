import { createEnvironmentSectionAtoms } from "@t3tools/client-runtime/state/sections";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentProjects } from "./projects";
import { serverEnvironment } from "./server";

export const environmentSections = createEnvironmentSectionAtoms(connectionAtomRuntime, {
  serverConfigValueAtom: serverEnvironment.configValueAtom,
  projectsAtom: environmentProjects.environmentProjectsAtom,
});
