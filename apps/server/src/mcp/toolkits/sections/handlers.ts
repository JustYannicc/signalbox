import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Sections from "../../../sections/Sections.ts";
import type { SectionError } from "../../../sections/SectionsError.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { SectionsToolkit } from "./tools.ts";

const sectionFailure = (error: SectionError | OrchestratorMcpFailure) =>
  error._tag === "OrchestratorMcpFailure"
    ? error
    : error._tag === "SectionStorageError"
      ? unavailable()
      : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const read = Effect.gen(function* () {
  yield* readCaller();
  return yield* Sections.Sections;
});

// Sections organize every project in the environment, so changing them is an
// environment change: the declaration requires a full-access caller.
const mutate = <A>(
  change: (sections: Sections.Sections["Service"]) => Effect.Effect<A, SectionError>,
) => Sections.Sections.pipe(Effect.flatMap(change), Effect.mapError(sectionFailure));

export const layer = McpToolAccess.toLayer(SectionsToolkit, {
  t3_section_list: McpToolAccess.reads(() =>
    read.pipe(
      Effect.flatMap((sections) => sections.snapshot),
      Effect.mapError(sectionFailure),
    ),
  ),
  t3_project_section_chain: McpToolAccess.reads(({ projectId }) =>
    read.pipe(
      Effect.flatMap((sections) => sections.getProjectSectionChain(projectId)),
      Effect.mapError(sectionFailure),
    ),
  ),
  t3_section_create: McpToolAccess.writesEnvironment((input) =>
    mutate((sections) => sections.create(input)),
  ),
  t3_section_update: McpToolAccess.writesEnvironment((input) =>
    mutate((sections) => sections.update(input)),
  ),
  t3_section_move: McpToolAccess.writesEnvironment((input) =>
    mutate((sections) => sections.move(input)),
  ),
  t3_section_delete: McpToolAccess.writesEnvironment((input) =>
    mutate((sections) => sections.delete(input)),
  ),
  t3_project_move_to_section: McpToolAccess.writesEnvironment((input) =>
    mutate((sections) => sections.moveProject(input)),
  ),
});
