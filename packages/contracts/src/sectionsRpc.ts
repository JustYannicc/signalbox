import {
  SectionCreateInput,
  SectionDeleteInput,
  SectionMoveInput,
  SectionProjectMoveInput,
  SectionUpdateInput,
  SectionsRpcError,
  SectionsSnapshot,
} from "./sections.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

export const SECTION_WS_METHODS = {
  sectionsSubscribe: "sections.subscribe",
  sectionsCreate: "sections.create",
  sectionsUpdate: "sections.update",
  sectionsMove: "sections.move",
  sectionsDelete: "sections.delete",
  sectionsMoveProject: "sections.moveProject",
} as const;

const SectionsRpcFailure = Schema.Union([SectionsRpcError, EnvironmentAuthorizationError]);

const SectionsSubscribeRpc = Rpc.make(SECTION_WS_METHODS.sectionsSubscribe, {
  payload: Schema.Struct({}),
  success: SectionsSnapshot,
  error: SectionsRpcFailure,
  stream: true,
});
const SectionsCreateRpc = Rpc.make(SECTION_WS_METHODS.sectionsCreate, {
  payload: SectionCreateInput,
  success: SectionsSnapshot,
  error: SectionsRpcFailure,
});
const SectionsUpdateRpc = Rpc.make(SECTION_WS_METHODS.sectionsUpdate, {
  payload: SectionUpdateInput,
  success: SectionsSnapshot,
  error: SectionsRpcFailure,
});
const SectionsMoveRpc = Rpc.make(SECTION_WS_METHODS.sectionsMove, {
  payload: SectionMoveInput,
  success: SectionsSnapshot,
  error: SectionsRpcFailure,
});
const SectionsDeleteRpc = Rpc.make(SECTION_WS_METHODS.sectionsDelete, {
  payload: SectionDeleteInput,
  success: SectionsSnapshot,
  error: SectionsRpcFailure,
});
const SectionsMoveProjectRpc = Rpc.make(SECTION_WS_METHODS.sectionsMoveProject, {
  payload: SectionProjectMoveInput,
  success: SectionsSnapshot,
  error: SectionsRpcFailure,
});

export const SectionRpcs = [
  SectionsSubscribeRpc,
  SectionsCreateRpc,
  SectionsUpdateRpc,
  SectionsMoveRpc,
  SectionsDeleteRpc,
  SectionsMoveProjectRpc,
] as const;

export const SectionsWsRpcGroup = RpcGroup.make(...SectionRpcs);
