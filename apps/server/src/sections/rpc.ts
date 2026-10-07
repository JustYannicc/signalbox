import { SectionsRpcError, WS_METHODS } from "@t3tools/contracts";
import type { SectionId } from "@t3tools/contracts/sections";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Sections from "./Sections.ts";
import type { SectionError } from "./SectionsError.ts";

const toRpcError = (error: SectionError): SectionsRpcError => {
  switch (error._tag) {
    case "SectionNotFoundError":
      return new SectionsRpcError({
        code: "section-not-found",
        detail: error.message,
        sectionId: error.sectionId as SectionId,
      });
    case "SectionInvalidNameError":
      return new SectionsRpcError({ code: "invalid-name", detail: error.message });
    case "SectionInvalidMoveError":
      return new SectionsRpcError({
        code: "invalid-move",
        detail: error.message,
        ...(error.sectionId === undefined ? {} : { sectionId: error.sectionId as SectionId }),
        ...(error.parentId === undefined ? {} : { parentId: error.parentId as SectionId | null }),
        ...(error.projectId === undefined ? {} : { projectId: error.projectId }),
      });
    case "SectionProjectNotFoundError":
      return new SectionsRpcError({
        code: "project-not-found",
        detail: error.message,
        projectId: error.projectId,
      });
    case "SectionStorageError":
      return new SectionsRpcError({
        code: "storage-failed",
        detail: "Could not load or update sections.",
      });
  }
};

/** WebSocket handlers for the sections RPCs, served by `signalbox/wsRpc.ts`. */
export const makeSectionsWsHandlers = Effect.gen(function* () {
  const sections = yield* Sections.Sections;
  return {
    [WS_METHODS.sectionsSubscribe]: (_input: {}) =>
      sections.changes.pipe(Stream.mapError(toRpcError)),
    [WS_METHODS.sectionsCreate]: (input: Parameters<typeof sections.create>[0]) =>
      sections.create(input).pipe(Effect.mapError(toRpcError)),
    [WS_METHODS.sectionsUpdate]: (input: Parameters<typeof sections.update>[0]) =>
      sections.update(input).pipe(Effect.mapError(toRpcError)),
    [WS_METHODS.sectionsMove]: (input: Parameters<typeof sections.move>[0]) =>
      sections.move(input).pipe(Effect.mapError(toRpcError)),
    [WS_METHODS.sectionsDelete]: (input: Parameters<typeof sections.delete>[0]) =>
      sections.delete(input).pipe(Effect.mapError(toRpcError)),
    [WS_METHODS.sectionsMoveProject]: (input: Parameters<typeof sections.moveProject>[0]) =>
      sections.moveProject(input).pipe(Effect.mapError(toRpcError)),
  };
});
