import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { httpRequest } from "./steps.ts";

/** Runs `w.http` against a client that records the request and answers 200 `{}`. */
const send = (request: unknown) => {
  const sent: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((outgoing) => {
    sent.push(outgoing);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        outgoing,
        new Response("{}", { headers: { "content-type": "application/json" } }),
      ),
    );
  });
  return httpRequest(request, { idempotencyKey: "key-1", timeoutMs: 1_000 }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.exit,
    Effect.map((exit) => ({ exit, sent })),
  );
};

describe("httpRequest", () => {
  it.effect("sends the method and stringifies header values", () =>
    Effect.gen(function* () {
      const { exit, sent } = yield* send({
        url: "https://example.com/items",
        method: "patch",
        headers: { "x-text": "a", "x-count": 3, "x-flag": true },
      });
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(sent[0]?.method).toBe("PATCH");
      expect(sent[0]?.headers).toMatchObject({
        "x-text": "a",
        "x-count": "3",
        "x-flag": "true",
        "idempotency-key": "key-1",
      });
    }),
  );

  it.effect("refuses a method it can't send, naming the ones it can", () =>
    Effect.gen(function* () {
      const { exit, sent } = yield* send({ url: "https://example.com", method: "fetch" });
      expect(sent).toHaveLength(0);
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: {
          reasons: [
            {
              error: {
                message: "w.http can't send a FETCH request.",
                cause: { fix: "Use one of: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS." },
              },
            },
          ],
        },
      });
    }),
  );
});
