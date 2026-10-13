/**
 * Calls to a Signalbox Cloud pool over its pool link (`POOL_LINK_PATH`): the
 * token a pool moved to the cloud keeps, so this server can still run the
 * pool's threads (its harnesses use `<link>/v1` as their provider API).
 *
 * @module accountHub/poolLinkClient
 */
import {
  POOL_LINK_PATH,
  PoolLinkInfo,
  PoolLinkMoveResult,
  type PoolLinkMoveRequest,
} from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { AccountHubError, hostOf, normalizeHubUrl, unreachable } from "./accountHubManagement.ts";

export interface PoolLink {
  /** The cloud's origin, e.g. `https://app.signalbox.sh`, normalized by `poolLink`. */
  readonly url: string;
  readonly token: string;
}

export const poolLink = (url: string, token: string): PoolLink => ({
  url: normalizeHubUrl(url),
  token,
});

/** Where the link answers; its `/v1` is the pool's model API. */
export const linkBaseUrl = (link: PoolLink) => `${link.url}${POOL_LINK_PATH}`;

const LinkError = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

const call = <A>(
  link: PoolLink,
  request: HttpClientRequest.HttpClientRequest,
  success: Schema.Decoder<A>,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const endpoint = { baseUrl: link.url };
    const response = yield* http.execute(HttpClientRequest.bearerToken(request, link.token)).pipe(
      Effect.mapError((cause) => unreachable(endpoint, cause)),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            new AccountHubError({
              detail: `${hostOf(endpoint)} did not answer within 30 seconds.`,
            }),
          ),
      }),
    );
    if (response.status >= 300) {
      const body = yield* HttpClientResponse.schemaBodyJson(LinkError)(response).pipe(
        Effect.option,
      );
      return yield* new AccountHubError({
        detail:
          body._tag === "Some"
            ? body.value.error.message
            : `${hostOf(endpoint)} answered ${response.status} to the pool link.`,
      });
    }
    return yield* HttpClientResponse.schemaBodyJson(success)(response).pipe(
      Effect.mapError(
        (cause) =>
          new AccountHubError({ detail: `${hostOf(endpoint)} sent an unexpected answer.`, cause }),
      ),
    );
  });

/** The cloud pool's name and accounts, which also proves the link works. */
export const readLink = (link: PoolLink) =>
  call(link, HttpClientRequest.get(linkBaseUrl(link)), PoolLinkInfo);

/** Moves credential files into the cloud pool: all of them, or none if any fails. */
export const moveAccountsIn = (link: PoolLink, accounts: PoolLinkMoveRequest["accounts"]) =>
  call(
    link,
    HttpClientRequest.post(`${linkBaseUrl(link)}/accounts`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ accounts } satisfies PoolLinkMoveRequest),
    ),
    PoolLinkMoveResult,
  );
