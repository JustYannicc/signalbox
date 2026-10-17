import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { testSignInEnv } from "./testSignInEnv.ts";

it.effect("omits all test bindings in production even when secrets are supplied", () =>
  Effect.gen(function* () {
    const env = {
      E2E_SIGN_IN_SECRET: "fictional-signing-secret",
      E2E_WORKOS_CLIENT_ID: "client_fictional",
      E2E_WORKOS_API_KEY: "sk_test_fictional",
    };
    const bindings = yield* Effect.all([testSignInEnv(true), testSignInEnv(false)]).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    );
    expect(bindings[0]).toEqual({});
    expect(bindings[1]).toHaveProperty("E2E_WORKOS_CLIENT_ID", env.E2E_WORKOS_CLIENT_ID);
    expect(JSON.stringify(bindings[1])).not.toContain(env.E2E_WORKOS_API_KEY);
    const preview = yield* testSignInEnv(false).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    );
    if (!("E2E_WORKOS_API_KEY" in preview)) throw new Error("missing preview bindings");
    expect(Redacted.value(preview.E2E_WORKOS_API_KEY)).toBe(env.E2E_WORKOS_API_KEY);
  }),
);
