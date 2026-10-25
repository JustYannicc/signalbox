import type { WorkOSConfig, WorkOSUser } from "@signalbox/account/WorkOSClient";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { TestSignInRequest } from "./TestSignInPolicy.ts";
import * as IdentityProvider from "../account/IdentityProvider.ts";

const EMAILS = {
  richard: "richard@piedpiper.example",
  jared: "jared@piedpiper.example",
  gilfoyle: "gilfoyle@piedpiper.example",
  dinesh: "dinesh@piedpiper.example",
  erlich: "erlich@hackerhostel.example",
  gavin: "gavin@hooli.example",
  "big-head": "nelson@hooli.example",
  fresh: "casey@signalbox.example",
} as const;

const LOOKUP_TIMEOUT_MS = 10_000;

const User = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  external_id: Schema.String,
  first_name: Schema.NullOr(Schema.String),
  last_name: Schema.NullOr(Schema.String),
});

export class TestIdentityUnavailable extends Schema.TaggedError<TestIdentityUnavailable>()(
  "TestIdentityUnavailable",
  {},
) {
  override get message() {
    return "The test identity is unavailable.";
  }
}

export class TestIdentities extends Context.Service<
  TestIdentities,
  {
    readonly resolve: (
      name: TestSignInRequest["user"],
    ) => Effect.Effect<
      { readonly user: WorkOSUser; readonly workos: WorkOSConfig },
      TestIdentityUnavailable
    >;
  }
>()("@signalbox/cloud/testSignIn/TestIdentities") {}

const make = Effect.gen(function* () {
  const clientId = Option.getOrUndefined(
    yield* Config.String("E2E_WORKOS_CLIENT_ID").pipe(Config.option),
  );
  const apiKey = Option.getOrUndefined(
    yield* Config.Redacted("E2E_WORKOS_API_KEY").pipe(Config.option),
  );
  const normalClientId = Option.getOrUndefined(
    yield* Config.String("T3CODE_WORKOS_CLIENT_ID").pipe(Config.option),
  );
  const normalApiKey = Option.getOrUndefined(
    yield* Config.Redacted("T3CODE_WORKOS_API_KEY").pipe(Config.option),
  );
  const http = yield* HttpClient.HttpClient;
  const identityProviders = yield* IdentityProvider.IdentityProviders;

  const resolve: TestIdentities["Service"]["resolve"] = Effect.fn("TestIdentities.resolve")(
    function* (name) {
      // Production WorkOS keys must never identify test users, even on a preview.
      if (
        !clientId ||
        !apiKey ||
        !Redacted.value(apiKey).startsWith("sk_test_") ||
        clientId.trim() === normalClientId?.trim() ||
        (normalApiKey !== undefined && Redacted.value(apiKey) === Redacted.value(normalApiKey))
      ) {
        return yield* new TestIdentityUnavailable({});
      }
      const externalId = `signalbox-test:${name}`;
      const { record } = yield* Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.get(
            `https://api.workos.com/user_management/users/external_id/${encodeURIComponent(externalId)}`,
          ).pipe(HttpClientRequest.bearerToken(Redacted.value(apiKey))),
        );
        if (response.status !== 200) return yield* new TestIdentityUnavailable({});
        return { record: yield* HttpClientResponse.schemaBodyJson(User)(response) };
      }).pipe(
        Effect.timeout(LOOKUP_TIMEOUT_MS),
        Effect.mapError(() => new TestIdentityUnavailable({})),
      );
      if (record.external_id !== externalId || record.email !== EMAILS[name]) {
        return yield* new TestIdentityUnavailable({});
      }
      const workos = yield* identityProviders
        .identityProviderForUser(record.id)
        .pipe(Effect.mapError(() => new TestIdentityUnavailable({})));
      // A recreated or unregistered sandbox identity must never enter the primary realm.
      if (
        workos.clientId !== clientId ||
        workos.apiKey === undefined ||
        Redacted.value(workos.apiKey) !== Redacted.value(apiKey)
      ) {
        return yield* new TestIdentityUnavailable({});
      }
      return {
        user: {
          id: record.id,
          email: record.email,
          ...(record.first_name ? { firstName: record.first_name } : {}),
          ...(record.last_name ? { lastName: record.last_name } : {}),
        },
        workos,
      };
    },
  );
  return TestIdentities.of({ resolve });
});

export const layer = Layer.effect(TestIdentities, make);
