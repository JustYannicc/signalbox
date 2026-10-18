import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CloudConfig from "./CloudConfig.ts";
import * as Environment from "./environment.ts";
import { CLOUD_TEST_ENV } from "./testing.ts";

describe("cloud terminal availability", () => {
  it.effect.each([false, true])("advertises terminals only with drive bindings: %s", (drives) =>
    Effect.gen(function* () {
      const config = yield* CloudConfig.CloudConfig;
      expect(Environment.descriptor(config).capabilities.terminal).toBe(drives);
    }).pipe(
      Effect.provide(
        CloudConfig.layerWithDrives(drives).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: CLOUD_TEST_ENV }))),
        ),
      ),
    ),
  );
});
