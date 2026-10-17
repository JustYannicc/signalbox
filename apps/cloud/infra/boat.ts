import * as Boat from "@signalbox/alchemy-boat";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "alchemy/Output";

import { BOAT_RUNNER_SETUP } from "../src/thread/runner/boat/runnerSetup.ts";
import type { CloudStage } from "./stage.ts";

// The deployment credential never becomes a Worker binding. Resolve it only
// when Boat is used, so installations using containers need no Boat account.
export const boatProviders = Boat.providers({
  credentials: Layer.succeed(
    Boat.Credentials,
    Config.Redacted("BOAT_DEPLOY_API_KEY").pipe(
      Effect.map((apiKey) => ({ apiKey, apiBaseUrl: Boat.DEFAULT_API_BASE_URL })),
      Effect.orDie,
    ),
  ),
});

export const boatRunner = (target: CloudStage) =>
  Effect.gen(function* () {
    const backend = yield* Config.String("MACHINE_BACKEND").pipe(Config.withDefault(""));
    if (backend.trim() !== "boat") return {};

    const name = `${target.cloudWorker}-runner`;
    const environment = yield* Boat.Environment("BoatRunnerEnvironment", {
      name,
      safeForThirdParties: true,
      passGithub: false,
      passSecrets: false,
      passSandboxCredentials: false,
      passAgentsCredentials: false,
      vars: {},
      secretFiles: {},
      repositories: [],
    });
    const snapshot = yield* Boat.NamedSnapshot("BoatRunnerSnapshot", {
      name,
      type: "small",
      setupScript: BOAT_RUNNER_SETUP,
    });
    const key = yield* Boat.ApiKey("BoatRunnerKey", {
      name,
      ttl: "365d",
      actions: [
        "sandbox.create",
        "sandbox.read",
        "sandbox.update",
        "sandbox.stop",
        "sandbox.resume",
        "sandbox.delete",
        "file.write",
        "snapshot.read",
      ],
      // Existing thread VMs predate this environment. The new key must still
      // resume them, rather than forcing every thread onto a fresh disk.
    });

    return {
      BOAT_RUNNER_ENVIRONMENT: environment.name,
      BOAT_RUNNER_SNAPSHOT: snapshot.name,
      BOAT_RUNNER_API_KEY: Output.map(key.secret, (secret) => {
        if (secret === undefined) {
          throw new Error(
            "BoatRunnerKey has no stored secret. Adoption never rotates an existing key; recover its secret or choose a new resource name.",
          );
        }
        return secret;
      }),
    };
  });
