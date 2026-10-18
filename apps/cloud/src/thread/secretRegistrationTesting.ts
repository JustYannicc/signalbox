import * as Effect from "effect/Effect";

import {
  migrateSecretRunIdentity,
  migrateSecretValues,
  migrateCurrentSecretValues,
} from "./runner/secretValues.ts";
import {
  migrateSecretSends,
  readSecretAsks,
  saveSecretAsk,
  readSecretSources,
  saveSecretSources,
} from "./egress/secretSendTables.ts";

export { beginSecretRun, readSecretValues, registerSecretValues } from "./runner/secretValues.ts";
export { readSecretAsks, saveSecretAsk, readSecretSources, saveSecretSources };

/** Applies the storage steps before run identity so tests can stage an upgrade. */
export const migrateSecretRegistrationThroughCurrentValues = Effect.gen(function* () {
  yield* migrateSecretValues;
  yield* migrateSecretSends;
  yield* migrateCurrentSecretValues;
});

export const migrateSecretRegistrationRunIdentity = migrateSecretRunIdentity;
