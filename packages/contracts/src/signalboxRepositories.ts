/**
 * Signalbox repository listing. Part of `WsRpcGroup`.
 *
 * "Add project" offers the repositories the user's connected account can
 * reach, so picking one is a click instead of typing `owner/name`. Signalbox
 * Cloud lists them with the user's GitHub connection. A self-hosted server
 * answers `SourceControlRepositoryError`, and clients fall back to typing a
 * name, which upstream's `sourceControl.lookupRepository` checks.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import {
  SourceControlProviderKind,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
} from "./sourceControl.ts";

export const SIGNALBOX_REPOSITORIES_WS_METHODS = {
  list: "signalbox.repositories.list",
} as const;

/** Same as looking one repository up. */
export const SIGNALBOX_REPOSITORIES_REQUIRED_SCOPES = {
  [SIGNALBOX_REPOSITORIES_WS_METHODS.list]: AuthOrchestrationReadScope,
} as const;

export const SignalboxRepositoryListInput = Schema.Struct({
  provider: SourceControlProviderKind,
});
export type SignalboxRepositoryListInput = typeof SignalboxRepositoryListInput.Type;

/** Most recently pushed first. */
export const SignalboxRepositoryList = Schema.Struct({
  repositories: Schema.Array(SourceControlRepositoryInfo),
});
export type SignalboxRepositoryList = typeof SignalboxRepositoryList.Type;

const ListRpc = Rpc.make(SIGNALBOX_REPOSITORIES_WS_METHODS.list, {
  payload: SignalboxRepositoryListInput,
  success: SignalboxRepositoryList,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

export const SIGNALBOX_REPOSITORIES_RPCS = [ListRpc] as const;
