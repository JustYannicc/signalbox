import * as Effect from "effect/Effect";

import { GitHubConnection } from "../github/GitHubConnection.ts";
import { ConnectionLinks } from "./ConnectionLinks.ts";

/**
 * What a connection link sees, answered in the user's object: the accounts
 * they connected, and a fresh token for one. Every connected service is one
 * entry in `LINKED_PROVIDERS`; GitHub is the first.
 */

export const LINKED_PROVIDERS = ["github"] as const;
export type LinkedProvider = (typeof LINKED_PROVIDERS)[number];

export const isLinkedProvider = (value: string): value is LinkedProvider =>
  (LINKED_PROVIDERS as ReadonlyArray<string>).includes(value);

export type LinkedConnections =
  | {
      readonly _tag: "connections";
      readonly connections: ReadonlyArray<{
        readonly provider: LinkedProvider;
        readonly account: string;
      }>;
    }
  | { readonly _tag: "invalid_link" };

export type LinkedToken =
  | { readonly _tag: "token"; readonly token: string; readonly expiresAt: number | null }
  | { readonly _tag: "invalid_link" }
  | { readonly _tag: "not_connected" }
  | { readonly _tag: "unavailable"; readonly message: string };

const INVALID_LINK = { _tag: "invalid_link" } as const;

export const linkedConnections = (secret: string) =>
  Effect.gen(function* () {
    if (!(yield* (yield* ConnectionLinks).check(secret))) return INVALID_LINK;
    const github = yield* (yield* GitHubConnection).account;
    return {
      _tag: "connections",
      connections: github === null ? [] : [{ provider: "github", account: github.login }],
    } satisfies LinkedConnections;
  });

export const linkedToken = (input: {
  readonly secret: string;
  readonly provider: LinkedProvider;
}) =>
  Effect.gen(function* () {
    if (!(yield* (yield* ConnectionLinks).check(input.secret))) return INVALID_LINK;
    // Only GitHub being down is "unavailable"; anything else is a real failure.
    const token = yield* (yield* GitHubConnection).accessToken.pipe(
      Effect.catchTags({
        GitHubError: (error) =>
          Effect.logWarning("a linked GitHub token couldn't be fetched", { error }).pipe(
            Effect.as(undefined),
          ),
      }),
    );
    if (token === undefined) {
      return {
        _tag: "unavailable",
        message: "GitHub is unreachable right now.",
      } satisfies LinkedToken;
    }
    return token === null
      ? ({ _tag: "not_connected" } satisfies LinkedToken)
      : ({ _tag: "token", token, expiresAt: null } satisfies LinkedToken);
  });
