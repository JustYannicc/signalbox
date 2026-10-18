import { SectionId } from "@t3tools/contracts/sections";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  FolderId,
  FolderOrigin,
  OnePasswordEnvironmentId,
  SecretEnvironmentName,
} from "@t3tools/contracts/signalboxFolders";
import * as Schema from "effect/Schema";

import * as ResourceBindings from "./ResourceBindings.ts";

export const SecretEnvironmentNamesJson = Schema.fromJsonString(
  Schema.Array(SecretEnvironmentName),
);
const SecretEnvironmentNames = Schema.Array(SecretEnvironmentName);

/** Folder rows in the preview setup wire format. */
export const FolderRow = Schema.Struct({
  id: FolderId,
  owner_id: SignalboxContextId,
  parent_id: Schema.NullOr(FolderId),
  name: Schema.String,
  position: Schema.Number,
  drive_id: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String),
  // Optional: a cloud from before folder lineage (#678 part 2) sends none.
  origin: Schema.optionalKey(Schema.NullOr(Schema.fromJsonString(FolderOrigin))),
  // Optional: a cloud from before folder secrets (#395) sends none.
  secrets_environment_id: Schema.optionalKey(Schema.NullOr(OnePasswordEnvironmentId)),
  // Optional: a cloud from before per-secret subfolder access sends none.
  secrets_include_subfolders: Schema.optionalKey(Schema.NullOr(SecretEnvironmentNames)),
  // Optional: a cloud from before folder phases (#677) sends none.
  phases: Schema.optionalKey(Schema.NullOr(Schema.String)),
  phase: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type FolderRow = typeof FolderRow.Type;

/** Folder rows as SQLite returns them. JSON text becomes an array before use. */
const FolderRowSql = Schema.Struct({
  ...FolderRow.fields,
  secrets_include_subfolders: Schema.optionalKey(Schema.NullOr(SecretEnvironmentNamesJson)),
});

export const FolderRows = Schema.Struct({
  folders: Schema.Array(FolderRow),
  bindings: Schema.Array(ResourceBindings.BindingRow),
  topInstructions: Schema.NullOr(Schema.String),
  topSecrets: Schema.optionalKey(Schema.NullOr(OnePasswordEnvironmentId)),
  topSecretsIncludeSubfolders: Schema.optionalKey(Schema.NullOr(SecretEnvironmentNames)),
});
export type FolderRows = typeof FolderRows.Type;
export const decodeFolderRows = Schema.decodeUnknownSync(Schema.Array(FolderRowSql));

/**
 * Sections and project placements as clouds from before folders stored and
 * sent them (`0004`), for a preview taking such a cloud's setup
 * (`previewSetup/`). `UserFolders` reads them into folders.
 */

export const SectionRow = Schema.Struct({
  id: SectionId,
  context_id: Schema.String,
  parent_id: Schema.NullOr(SectionId),
  name: Schema.String,
  position: Schema.Number,
});
export const PlacementRow = Schema.Struct({
  project_id: Schema.String,
  section_id: Schema.NullOr(SectionId),
  position: Schema.Number,
});
export const SectionRows = Schema.Struct({
  sections: Schema.Array(SectionRow),
  placements: Schema.Array(PlacementRow),
  // Optional: a cloud from before pools by hierarchy sends none.
  bindings: Schema.optionalKey(Schema.Array(ResourceBindings.BindingRow)),
});
export type SectionRows = typeof SectionRows.Type;
export const decodeSectionRows = Schema.decodeUnknownSync(Schema.Array(SectionRow));
export const decodePlacementRows = Schema.decodeUnknownSync(Schema.Array(PlacementRow));
