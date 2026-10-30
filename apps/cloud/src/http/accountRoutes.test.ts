import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";

import { CLOUD_TEST_ENV, layerAccounts } from "../testing.ts";
import * as AccountRoutes from "./accountRoutes.ts";

it.effect("email authorize sends a code only after a first-party action", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      layerAccounts(
        {},
        {
          ...CLOUD_TEST_ENV,
          T3CODE_WORKOS_API_KEY: "sk_test",
        },
      ),
    );
    const http = yield* HttpRouter.toHttpEffect(AccountRoutes.layer);
    const handler = HttpEffect.toWebHandler(http.pipe(Effect.provide(context)));
    const url =
      "https://cloud.test/api/account/authorize?provider=email&mode=browser&origin=https%3A%2F%2Funtrusted.example&loginHint=person%40example.com";
    for (const headers of [
      {},
      { "sec-fetch-site": "cross-site" },
      { referer: "https://untrusted.example/sign-in" },
    ]) {
      const response = yield* Effect.promise(() => handler(new Request(url, { headers })));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/sign-in?provider=email");
      expect(response.headers.get("location")).not.toContain("verify=");
    }
    for (const headers of [
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      { referer: "https://cloud.test/sign-in" },
    ]) {
      const response = yield* Effect.promise(() => handler(new Request(url, { headers })));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/sign-in?verify=");
    }
  }).pipe(Effect.scoped),
);
