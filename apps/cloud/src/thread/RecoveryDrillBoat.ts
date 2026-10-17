import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/http";

import { BoatApiError, makeBoatApi, type BoatApi } from "./runner/boat/BoatApi.ts";

export interface BoatRecoverySettings {
  readonly apiUrl: string;
  readonly apiKey: Redacted.Redacted<string>;
}

export interface BoatRecoveryMachineSnapshot {
  readonly machineId: string;
  readonly exists: boolean;
  readonly state: string | null;
  readonly hydrated: boolean | null;
}

export class BoatRecoveryControl extends Context.Service<
  BoatRecoveryControl,
  {
    /** A fresh provider read. The null result from Boat is a verified absence. */
    readonly inspect: (
      machineId: string,
    ) => Effect.Effect<BoatRecoveryMachineSnapshot, BoatApiError>;
    /** Uses Boat's destructive DELETE with its required confirmation header. */
    readonly remove: (machineId: string) => Effect.Effect<void, BoatApiError>;
  } | null
>()("@signalbox/cloud/thread/RecoveryDrillBoat/BoatRecoveryControl") {}

const safeState = (state: string) =>
  state.length <= 40 && /^[a-z][a-z0-9_-]*$/iu.test(state) ? state : "unknown";

const makeBoatRecoveryControl = (api: BoatApi): NonNullable<BoatRecoveryControl["Service"]> => ({
  inspect: (machineId) =>
    Effect.flatMap(
      api.get(machineId),
      (sandbox): Effect.Effect<BoatRecoveryMachineSnapshot, BoatApiError> => {
        if (sandbox === null) {
          return Effect.succeed<BoatRecoveryMachineSnapshot>({
            machineId,
            exists: false,
            state: null,
            hydrated: null,
          });
        }
        if (sandbox.id !== machineId) {
          return Effect.fail(
            new BoatApiError({
              operation: "get",
              status: 200,
              code: "id_mismatch",
              message: "boat returned a different sandbox.",
            }),
          );
        }
        return Effect.succeed<BoatRecoveryMachineSnapshot>({
          machineId,
          exists: true,
          state: safeState(sandbox.state),
          hydrated: sandbox.hydrated ?? null,
        });
      },
    ),
  remove: (machineId) => api.remove(machineId),
});

export const makeBoatRecoveryControlWithClient = (
  client: HttpClient.HttpClient,
  settings: BoatRecoverySettings,
) =>
  makeBoatRecoveryControl(
    makeBoatApi(client, { baseUrl: settings.apiUrl, apiKey: settings.apiKey }),
  );

export const layer = (settings: BoatRecoverySettings | null) =>
  Layer.effect(
    BoatRecoveryControl,
    Effect.gen(function* () {
      if (settings === null) return null;
      const client = yield* HttpClient.HttpClient;
      return makeBoatRecoveryControlWithClient(client, settings);
    }),
  );
