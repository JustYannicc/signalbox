import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  SYNTHETIC_SECRET_ENVIRONMENT,
  SYNTHETIC_SECRET_NAMES,
} from "@signalbox/runner-protocol/SyntheticSecrets";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Base64 from "effect/encoding/Base64";

import { OnePasswordError, type OnePasswordClient } from "./RunnerOnePassword.ts";

// This reserved source exercises normal masking and registration without a real vault.
export const makeRunnerSyntheticSecretClient = (): OnePasswordClient => ({
  variables: (environmentId) => {
    if (environmentId !== SYNTHETIC_SECRET_ENVIRONMENT) return Effect.succeed([]);

    return Crypto.Crypto.use((crypto) =>
      Effect.forEach(SYNTHETIC_SECRET_NAMES, (name) =>
        Effect.map(crypto.randomBytes(32), (bytes) => ({
          name,
          value: Base64.encode(bytes),
          masked: true,
        })),
      ),
    ).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.mapError(
        () => new OnePasswordError({ message: "Could not generate synthetic preview secrets." }),
      ),
    );
  },
});
