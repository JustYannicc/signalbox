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

import { AccountHubError, normalizeHubUrl } from "./accountHubManagement.ts";

export interface PoolLink {
  /** The cloud's origin, e.g. `https://app.signalbox.sh`. */
  readonly url: string;
  readonly token: string;
}

/** Where the link answers; its `/v1` is the pool's model API. */
export const linkBaseUrl = (link: PoolLink) => `${normalizeHubUrl(link.url)}${POOL_LINK_PATH}`;

const LinkError = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

const call = <A>(
  link: PoolLink,
  request: HttpClientRequest.HttpClientRequest,
  success: Schema.Decoder<A>,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const host = URL.canParse(link.url) ? new URL(link.url).host : link.url;
    const response = yield* http.execute(HttpClientRequest.bearerToken(request, link.token)).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(
        (cause) => new AccountHubError({ detail: `Could not reach ${host}.`, cause }),
      ),
    );
    if (response.status >= 300) {
      const body = yield* HttpClientResponse.schemaBodyJson(LinkError)(response).pipe(
        Effect.option,
      );
      return yield* new AccountHubError({
        detail:
          body._tag === "Some"
            ? body.value.error.message
            : `${host} answered ${response.status} to the pool link.`,
      });
    }
    return yield* HttpClientResponse.schemaBodyJson(success)(response).pipe(
      Effect.mapError(
        (cause) => new AccountHubError({ detail: `${host} sent an unexpected answer.`, cause }),
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
