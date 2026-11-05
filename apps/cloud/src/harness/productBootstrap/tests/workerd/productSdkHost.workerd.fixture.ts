import { HarnessError } from "../../../Harness.ts";
import * as Effect from "effect/Effect";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";
import {
  claudeSdkFileSystem,
  createClaudeSdkHostEntrypoint,
  installClaudeSdkHostEnvironment,
} from "../../../ClaudeSdkHost.ts";
import { adapterWithFileSystem, services } from "../../../tests/productHost/adapter.ts";
import { nativeFixture } from "../../../tests/productHost/native.ts";
import { fixtureSdkQuery } from "./productSdkQuery.fixture.ts";
import { RELEASE_MODULE_OMITTED_SYMBOL } from "../../../HarnessProcessLifetime.ts";

export default class extends createClaudeSdkHostEntrypoint<{
  readonly LIFETIME?: boolean;
  readonly SDK_OMISSION?: boolean;
}>({
  prepare: ({ env, input, context, process, files }) =>
    Effect.gen(function* () {
      const environment = yield* Effect.acquireRelease(
        Effect.sync(() => installClaudeSdkHostEnvironment(context, process)),
        (owner) => Effect.promise(() => owner.dispose()),
      );
      const deps = yield* services;
      const identity = systemIdentityForThread(input.session.threadId, {
        release: "fixture-kernel",
        version: "#1 fixture",
        machine: "x86_64",
        hostnamePolicy: "thread",
        verification: "measured",
      });
      const native = nativeFixture(
        input.session.initialNativeThreadId ?? "product-native-session",
        identity,
      );
      const loadSdk = env.LIFETIME ? native.loadSdk : fixtureSdkQuery(native);
      return {
        adapter: adapterWithFileSystem(
          claudeSdkFileSystem(files),
          deps,
          input.session.modelSelection.instanceId,
        ),
        mcpSessions: deps.mcpSessions,
        loadSdk: async () => {
          if (env.SDK_OMISSION) {
            const report: unknown = Reflect.get(globalThis, RELEASE_MODULE_OMITTED_SYMBOL);
            if (typeof report !== "function") throw new Error("SDK omission reporter is missing");
            report({
              code: "RELEASE_MODULE_OMITTED",
              inputPath: "sdk/omitted-fixture",
              tier: "corpus",
            });
          }
          return await loadSdk(environment.bridge);
        },
        assertCompatibility: environment.assertCompatibility,
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new HarnessError({ operation: "open", message: "Fixture SDK preparation failed", cause }),
      ),
    ),
}) {}
