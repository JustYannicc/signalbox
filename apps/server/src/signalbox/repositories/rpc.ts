import { SourceControlRepositoryError } from "@t3tools/contracts";
import {
  SIGNALBOX_REPOSITORIES_WS_METHODS,
  type SignalboxRepositoryListInput,
} from "@t3tools/contracts/signalboxRepositories";
import * as Effect from "effect/Effect";

/**
 * Listing repositories needs the user's connected GitHub, which only
 * Signalbox Cloud holds. A self-hosted server says so, and "Add project"
 * falls back to typing `owner/name`.
 */
export const signalboxRepositoriesWsHandlers = {
  [SIGNALBOX_REPOSITORIES_WS_METHODS.list]: (input: SignalboxRepositoryListInput) =>
    Effect.fail(
      new SourceControlRepositoryError({
        provider: input.provider,
        operation: "listRepositories",
        detail: "This server can't list repositories. Type the repository's name instead.",
      }),
    ),
};
