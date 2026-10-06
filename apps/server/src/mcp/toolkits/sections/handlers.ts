import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import * as Sections from "../../../sections/Sections.ts";
import type { SectionError } from "../../../sections/SectionsError.ts";
import { readCaller, readFullAccessCaller, unavailable } from "../../threadAccess.ts";
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

const mutate = Effect.gen(function* () {
  yield* readFullAccessCaller("Section changes require a live full-access/default caller.");
  return yield* Sections.Sections;
});

export const layer = SectionsToolkit.toLayer({
  t3_section_list: () =>
    read.pipe(
      Effect.flatMap((sections) => sections.snapshot),
      Effect.mapError(sectionFailure),
    ),
  t3_project_section_chain: ({ projectId }) =>
    read.pipe(
      Effect.flatMap((sections) => sections.getProjectSectionChain(projectId)),
      Effect.mapError(sectionFailure),
    ),
  t3_section_create: (input) =>
    mutate.pipe(
      Effect.flatMap((sections) => sections.create(input)),
      Effect.mapError(sectionFailure),
    ),
  t3_section_update: (input) =>
    mutate.pipe(
      Effect.flatMap((sections) => sections.update(input)),
      Effect.mapError(sectionFailure),
    ),
  t3_section_move: (input) =>
    mutate.pipe(
      Effect.flatMap((sections) => sections.move(input)),
      Effect.mapError(sectionFailure),
    ),
  t3_section_delete: (input) =>
    mutate.pipe(
      Effect.flatMap((sections) => sections.delete(input)),
      Effect.mapError(sectionFailure),
    ),
  t3_project_move_to_section: (input) =>
    mutate.pipe(
      Effect.flatMap((sections) => sections.moveProject(input)),
      Effect.mapError(sectionFailure),
    ),
});

export const layerRegistration = McpServer.toolkit(SectionsToolkit).pipe(Layer.provide(layer));
