import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpRouter } from "effect/http";

import { makeMemoryCloud } from "../testing.ts";
import { UserDirectory, UserObjectError } from "../user/UserDirectory.ts";
import { layer as hookRoutes } from "./hookRoutes.ts";
import { signedBody } from "./hookTesting.ts";
import { verifySignature } from "./webhookRequest.ts";

const SECRET = "route-test-secret";
const BODY = '{"text":"Grüezi 👋"}';
const SIGNATURE = {
  header: "x-hub-signature-256",
  prefix: "sha256=",
  encoding: "hex",
} as const;

describe("cloud hook HTTP routes", () => {
  it.effect("sends signed bytes and plain header records across Durable Object RPC", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const http = yield* HttpRouter.toHttpEffect(hookRoutes);
      const handler = HttpEffect.toWebHandler(
        http.pipe(
          Effect.provideService(UserDirectory, {
            ...cloud.userDirectory,
            forUser: (userId) => ({
              ...cloud.userDirectory.forUser(userId),
              receiveHook: (request) =>
                Effect.gen(function* () {
                  // Cloudflare RPC rejects objects with custom prototypes.
                  if (Object.getPrototypeOf(request.headers) !== Object.prototype)
                    return yield* new UserObjectError({
                      operation: "receiveHook",
                      cause: new DOMException("Headers are not plain data", "DataCloneError"),
                    });
                  expect(userId).toBe("user_hooks");
                  expect(new TextDecoder().decode(request.body)).toBe(BODY);
                  const valid = yield* Effect.promise(() =>
                    verifySignature(SIGNATURE, SECRET, request),
                  );
                  return valid
                    ? { status: 202 as const, deliveryId: "delivery-1", duplicate: false }
                    : { status: 401 as const };
                }),
            }),
          }),
        ),
      );
      const signature = yield* Effect.promise(() => signedBody(BODY, SECRET));
      for (const path of [
        "/api/github/hooks/user_hooks/hook-1",
        "/api/hooks/user_hooks/hook-1/token-1",
      ]) {
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`https://cloud.test${path}`, {
              method: "POST",
              headers: { "x-hub-signature-256": signature },
              body: BODY,
            }),
          ),
        );
        expect(response.status).toBe(202);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          status: 202,
          deliveryId: "delivery-1",
          duplicate: false,
        });
      }
    }),
  );
});
