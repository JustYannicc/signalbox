import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as TestIdentities from "./TestIdentities.ts";

const ENV = {
  E2E_WORKOS_CLIENT_ID: "client_e2e_sandbox",
  E2E_WORKOS_API_KEY: "sk_test_fictional_e2e_key",
};
const RICHARD = {
  id: "user_test_richard",
  email: "richard@piedpiper.example",
  external_id: "signalbox-test:richard",
  first_name: "Richard",
  last_name: "Hendricks",
};

const resolveWith = (http: HttpClient.HttpClient, env: Readonly<Record<string, string>>) => {
  const layer = TestIdentities.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  return TestIdentities.TestIdentities.use((identities) => identities.resolve("richard")).pipe(
    Effect.provide(layer),
  );
};

const setup = (
  body: unknown = RICHARD,
  env: Readonly<Record<string, string>> = ENV,
  status = 200,
) => {
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
    }),
  );
  return { resolve: resolveWith(http, env), requests };
};

describe("test identities", () => {
  it.effect("uses the sandbox key and fixed external ID, then checks the fictional identity", () =>
    Effect.gen(function* () {
      const { resolve, requests } = setup();
      const result = yield* resolve;
      expect(requests).toEqual([
        {
          url: "https://api.workos.com/user_management/users/external_id/signalbox-test%3Arichard",
          authorization: `Bearer ${ENV.E2E_WORKOS_API_KEY}`,
        },
      ]);
      expect(result.user).toEqual({
        id: RICHARD.id,
        email: RICHARD.email,
        firstName: "Richard",
        lastName: "Hendricks",
      });
      expect(result.workos.clientId).toBe(ENV.E2E_WORKOS_CLIENT_ID);
    }),
  );

  it.effect("refuses production or missing credentials without making a request", () =>
    Effect.gen(function* () {
      for (const env of [{}, { ...ENV, E2E_WORKOS_API_KEY: "sk_live_wrong_environment" }]) {
        const { resolve, requests } = setup(RICHARD, env);
        expect((yield* resolve.pipe(Effect.flip))._tag).toBe("TestIdentityUnavailable");
        expect(requests).toEqual([]);
      }
    }),
  );

  it.effect("refuses the normal WorkOS client ID or API key without making a request", () =>
    Effect.gen(function* () {
      for (const env of [
        { ...ENV, T3CODE_WORKOS_CLIENT_ID: ENV.E2E_WORKOS_CLIENT_ID },
        {
          ...ENV,
          T3CODE_WORKOS_CLIENT_ID: "client_normal",
          T3CODE_WORKOS_API_KEY: ENV.E2E_WORKOS_API_KEY,
        },
      ]) {
        const { resolve, requests } = setup(RICHARD, env);
        expect((yield* resolve.pipe(Effect.flip))._tag).toBe("TestIdentityUnavailable");
        expect(requests).toEqual([]);
      }
    }),
  );

  it.effect(
    "refuses a different person, a wrong external ID, and unavailable sandbox responses",
    () =>
      Effect.gen(function* () {
        for (const body of [
          { ...RICHARD, email: "someone@other.example" },
          { ...RICHARD, external_id: "some-other-user" },
          {},
        ]) {
          expect((yield* setup(body).resolve.pipe(Effect.flip))._tag).toBe(
            "TestIdentityUnavailable",
          );
        }
        expect((yield* setup({}, ENV, 404).resolve.pipe(Effect.flip))._tag).toBe(
          "TestIdentityUnavailable",
        );
      }),
  );

  it.effect("times out while reading a sandbox user response body", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("{"));
                },
              }),
              { status: 200 },
            ),
          ),
        ),
      );
      const resolving = yield* Effect.forkChild(resolveWith(http, ENV));
      yield* TestClock.adjust(10_000);
      expect((yield* Fiber.join(resolving).pipe(Effect.flip))._tag).toBe("TestIdentityUnavailable");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
