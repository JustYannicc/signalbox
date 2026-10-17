import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as Platform from "../../../platform.ts";
import {
  type MachineBackendEnv,
  type MachineRecord,
  NO_MACHINE_RECORD,
} from "../MachineBackend.ts";
import { machineSettings } from "../machineBackends.ts";
import { makeBoatApi } from "./BoatApi.ts";
import { makeBoatMachineBackend } from "./BoatMachineBackend.ts";
import { BOAT_RUNNER_SETUP } from "./runnerSetup.ts";

const env = {
  MACHINE_BACKEND: "boat",
  BOAT_API_KEY: "legacy-key",
  CLOUD_URL: "https://cloud.test",
  MODEL_GATEWAY_URL: "https://gateway.test",
};

const createMachine = (overrides: MachineBackendEnv = {}) =>
  Effect.gen(function* () {
    const settings = machineSettings({ ...env, ...overrides });
    if (settings?.kind !== "boat") throw new Error("Boat settings were not configured.");
    const asked: Array<{
      readonly method: string;
      readonly url: string;
      readonly auth: string | undefined;
      readonly key: string | undefined;
      readonly body: unknown;
    }> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const bytes = request.body._tag === "Uint8Array" ? request.body.body : null;
        asked.push({
          method: request.method,
          url: request.url,
          auth: request.headers.authorization,
          key: request.headers["idempotency-key"],
          body: bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes)),
        });
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ sandbox: { id: "bx_1", state: "provisioning" } }, { status: 202 }),
        );
      }),
    );
    let record: MachineRecord = NO_MACHINE_RECORD;
    const backend = makeBoatMachineBackend({
      settings,
      api: makeBoatApi(client, { baseUrl: settings.apiUrl, apiKey: settings.apiKey }),
      crypto: yield* Crypto.Crypto,
      records: {
        get: Effect.sync(() => record),
        save: (next) =>
          Effect.sync(() => {
            record = next;
          }),
      },
    });
    const status = yield* backend.ensure({
      threadId: ThreadId.make("thread-boat-http"),
      generation: 1,
      token: "runner-token",
      machineClass: "heavy",
    });
    expect(status).toMatchObject({ actual: "starting", machineId: "bx_1" });
    expect(asked).toHaveLength(1);
    return asked[0]!;
  }).pipe(Effect.provide(Platform.layerCrypto));

describe("Boat sandbox create HTTP request", () => {
  it.effect("boots the prepared snapshot with its named environment and runner-scoped key", () =>
    Effect.gen(function* () {
      const asked = yield* createMachine({
        BOAT_RUNNER_API_KEY: "runner-key",
        BOAT_RUNNER_SNAPSHOT: "signalbox-runner-v1",
        BOAT_RUNNER_ENVIRONMENT: "signalbox-runner",
      });
      expect(asked).toEqual({
        method: "POST",
        url: "https://boat.dev/api/v1/sandboxes",
        auth: "Bearer runner-key",
        key: expect.any(String),
        body: {
          type: "small",
          ttlSeconds: 7200,
          from: "signalbox-runner-v1",
          environment: "signalbox-runner",
        },
      });
    }),
  );

  it.effect("keeps the setup script and noEnv isolation for a legacy VM", () =>
    Effect.gen(function* () {
      const asked = yield* createMachine();
      expect(asked.auth).toBe("Bearer legacy-key");
      expect(asked.body).toEqual({
        type: "small",
        ttlSeconds: 7200,
        setupScript: BOAT_RUNNER_SETUP,
        noEnv: true,
      });
    }),
  );

  it.effect("keeps noEnv isolation when only a snapshot is configured", () =>
    Effect.gen(function* () {
      const asked = yield* createMachine({ BOAT_RUNNER_SNAPSHOT: "signalbox-runner-v1" });
      expect(asked.body).toEqual({
        type: "small",
        ttlSeconds: 7200,
        from: "signalbox-runner-v1",
        noEnv: true,
      });
    }),
  );

  it.effect("installs the Runner when a named environment has no prepared snapshot", () =>
    Effect.gen(function* () {
      const asked = yield* createMachine({ BOAT_RUNNER_ENVIRONMENT: "signalbox-runner" });
      expect(asked.body).toEqual({
        type: "small",
        ttlSeconds: 7200,
        setupScript: BOAT_RUNNER_SETUP,
        environment: "signalbox-runner",
      });
    }),
  );
});
