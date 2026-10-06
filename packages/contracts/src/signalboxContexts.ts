/**
 * Signalbox contexts and sections. Part of `WsRpcGroup`.
 *
 * A context is an account a user works as: Personal, plus every work
 * organization they belong to, all shown at once. A thread acts as exactly one
 * context. Sections are the user's own organizing tree inside each context;
 * moving things between them never changes storage or access. See #125.
 *
 * Only Signalbox Cloud serves these (`capabilities.signalboxCloud`). A
 * self-hosted server answers `SignalboxContextsUnavailableError`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SIGNALBOX_CONTEXTS_WS_METHODS = {
  subscribe: "signalbox.contexts.subscribe",
  createSection: "signalbox.contexts.createSection",
  renameSection: "signalbox.contexts.renameSection",
  moveSection: "signalbox.contexts.moveSection",
  deleteSection: "signalbox.contexts.deleteSection",
} as const;

/** Reading is part of reading the sidebar; changing sections is an operation. */
export const SIGNALBOX_CONTEXTS_REQUIRED_SCOPES = {
  [SIGNALBOX_CONTEXTS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [SIGNALBOX_CONTEXTS_WS_METHODS.createSection]: AuthOrchestrationOperateScope,
  [SIGNALBOX_CONTEXTS_WS_METHODS.renameSection]: AuthOrchestrationOperateScope,
  [SIGNALBOX_CONTEXTS_WS_METHODS.moveSection]: AuthOrchestrationOperateScope,
  [SIGNALBOX_CONTEXTS_WS_METHODS.deleteSection]: AuthOrchestrationOperateScope,
} as const;

/** `"personal"`, or the WorkOS organization id of a work context. */
export const SignalboxContextId = TrimmedNonEmptyString.pipe(Schema.brand("SignalboxContextId"));
export type SignalboxContextId = typeof SignalboxContextId.Type;

/** Every user has exactly one Personal context. */
export const PERSONAL_CONTEXT_ID = SignalboxContextId.make("personal");

export const SignalboxContext = Schema.Struct({
  id: SignalboxContextId,
  kind: Schema.Literals(["personal", "organization"]),
  name: Schema.String,
});
export type SignalboxContext = typeof SignalboxContext.Type;

/** Chosen by the client that creates the section, so a retry is the same section. */
export const SignalboxSectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("SignalboxSectionId"),
);
export type SignalboxSectionId = typeof SignalboxSectionId.Type;

export const SIGNALBOX_SECTION_NAME_MAX_LENGTH = 120;

export const SignalboxSectionName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SIGNALBOX_SECTION_NAME_MAX_LENGTH),
);

export const SignalboxSection = Schema.Struct({
  id: SignalboxSectionId,
  contextId: SignalboxContextId,
  /** `null` for a section at the top of its context. */
  parentId: Schema.NullOr(SignalboxSectionId),
  name: SignalboxSectionName,
});
export type SignalboxSection = typeof SignalboxSection.Type;

/**
 * Everything the user's contexts look like. Contexts come Personal first;
 * sections come in their order among siblings.
 */
export const SignalboxContextsSnapshot = Schema.Struct({
  contexts: Schema.Array(SignalboxContext),
  sections: Schema.Array(SignalboxSection),
});
export type SignalboxContextsSnapshot = typeof SignalboxContextsSnapshot.Type;

export class SignalboxContextsUnavailableError extends Schema.TaggedError<SignalboxContextsUnavailableError>()(
  "SignalboxContextsUnavailableError",
  {},
) {
  override get message(): string {
    return "Contexts and sections are only available in Signalbox Cloud.";
  }
}

export class SignalboxSectionError extends Schema.TaggedError<SignalboxSectionError>()(
  "SignalboxSectionError",
  {
    reason: Schema.Literals([
      /** Not one of the user's current contexts. */
      "unknown-context",
      "unknown-section",
      /** The parent is missing, in another context, or the section itself or below it. */
      "invalid-parent",
      /** The id belongs to a different section. */
      "id-taken",
    ]),
  },
) {
  override get message(): string {
    return `The section change was rejected (${this.reason}).`;
  }
}

const SectionRpcError = Schema.Union([
  SignalboxSectionError,
  SignalboxContextsUnavailableError,
  EnvironmentAuthorizationError,
]);

/** A snapshot now and after every change, from any of the user's clients. */
const SubscribeRpc = Rpc.make(SIGNALBOX_CONTEXTS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: SignalboxContextsSnapshot,
  error: Schema.Union([SignalboxContextsUnavailableError, EnvironmentAuthorizationError]),
  stream: true,
});

/** Appends a section to its siblings. Creating the same section again is a no-op. */
const CreateSectionRpc = Rpc.make(SIGNALBOX_CONTEXTS_WS_METHODS.createSection, {
  payload: Schema.Struct({
    sectionId: SignalboxSectionId,
    contextId: SignalboxContextId,
    parentId: Schema.NullOr(SignalboxSectionId),
    name: SignalboxSectionName,
  }),
  error: SectionRpcError,
});

const RenameSectionRpc = Rpc.make(SIGNALBOX_CONTEXTS_WS_METHODS.renameSection, {
  payload: Schema.Struct({ sectionId: SignalboxSectionId, name: SignalboxSectionName }),
  error: SectionRpcError,
});

/** Moves a section within its context, to `index` among its new siblings. */
const MoveSectionRpc = Rpc.make(SIGNALBOX_CONTEXTS_WS_METHODS.moveSection, {
  payload: Schema.Struct({
    sectionId: SignalboxSectionId,
    parentId: Schema.NullOr(SignalboxSectionId),
    index: NonNegativeInt,
  }),
  error: SectionRpcError,
});

/** Its subsections take its place, so deleting a section never loses another one. */
const DeleteSectionRpc = Rpc.make(SIGNALBOX_CONTEXTS_WS_METHODS.deleteSection, {
  payload: Schema.Struct({ sectionId: SignalboxSectionId }),
  error: SectionRpcError,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_CONTEXTS_RPCS = [
  SubscribeRpc,
  CreateSectionRpc,
  RenameSectionRpc,
  MoveSectionRpc,
  DeleteSectionRpc,
] as const;
