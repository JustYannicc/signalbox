import { machineEnsureJson } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/http";

import { makeBoatApi } from "./boat/BoatApi.ts";
import { makeBoatMachineBackend } from "./boat/BoatMachineBackend.ts";
import { makeCloudflareMachineBackend } from "./cloudflare/CloudflareMachineBackend.ts";
import {
  CONNECT_TIMEOUT_MS,
  IDLE_TAIL_MS,
  MachineBackend,
  type MachineBackendEnv,
  MachineBackendError,
  type MachineBackendShape,
  type MachineHost,
  type MachineRecord,
  MachineRecords,
  type MachineStatus,
} from "./MachineBackend.ts";

/** Picks each machine class's backend from the Worker's vars and bindings (see `MachineBackend.ts`). */

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
};

const DEFAULT_RUNNER_IMAGE = "ghcr.io/justyannicc/signalbox-runner:nightly";
/** Also the most boat's trial allows. */
const DEFAULT_BOAT_TTL_SECONDS = 2 * 60 * 60;

export type MachineSettings =
  | { readonly kind: "local"; readonly runnerUrl: string; readonly modelGatewayUrl: string }
  | {
      readonly kind: "boat";
      readonly apiUrl: string;
      readonly apiKey: Redacted.Redacted<string>;
      readonly cloudUrl: string;
      readonly modelGatewayUrl: string;
      readonly image: string;
      readonly machineType: string;
      readonly ttlSeconds: number;
    };

/** The heavy backend the environment configures, or null when it cannot run Claude or Codex. */
export const machineSettings = (env: MachineBackendEnv): MachineSettings | null => {
  const modelGatewayUrl = nonEmpty(env.MODEL_GATEWAY_URL);
  if (modelGatewayUrl === null) return null;
  if (nonEmpty(env.MACHINE_BACKEND) === "boat") {
    const apiKey = nonEmpty(env.BOAT_API_KEY);
    const cloudUrl = nonEmpty(env.CLOUD_URL);
    if (apiKey === null || cloudUrl === null) return null;
    const ttlSeconds = Number(nonEmpty(env.BOAT_TTL_SECONDS) ?? DEFAULT_BOAT_TTL_SECONDS);
    return {
      kind: "boat",
      apiUrl: nonEmpty(env.BOAT_API_URL) ?? "https://boat.dev/api/v1",
      apiKey: Redacted.make(apiKey),
      cloudUrl,
      modelGatewayUrl,
      image: nonEmpty(env.RUNNER_IMAGE) ?? DEFAULT_RUNNER_IMAGE,
      machineType: nonEmpty(env.BOAT_MACHINE_TYPE) ?? "small",
      ttlSeconds:
        Number.isInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : DEFAULT_BOAT_TTL_SECONDS,
    };
  }
  const runnerUrl = env.LOCAL_WORKERD === "1" ? nonEmpty(env.LOCAL_RUNNER_URL) : null;
  return runnerUrl === null ? null : { kind: "local", runnerUrl, modelGatewayUrl };
};

const noBackend = (message: string) => () => Effect.fail(new MachineBackendError({ message }));

const nothing = (desired: MachineRecord["desired"]) => (): Effect.Effect<MachineStatus> =>
  Effect.succeed({ desired, actual: "none", machineId: null });

const NONE: MachineBackendShape = {
  kind: "none",
  shape: null,
  image: null,
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  idleTailMs: IDLE_TAIL_MS,
  ensure: noBackend("This cloud has no machine backend."),
  stop: nothing("stopped"),
  destroy: nothing("destroyed"),
  inspect: nothing("stopped"),
  pending: Effect.succeed(false),
  refresh: () => Effect.void,
  refreshEveryMs: null,
};

/** The developer's own machine. The Runner host keeps nothing to stop: a released Runner ends itself. */
const makeLocalBackend = (
  client: HttpClient.HttpClient,
  settings: Extract<MachineSettings, { kind: "local" }>,
): MachineBackendShape => ({
  ...NONE,
  kind: "local",
  ensure: (request) =>
    client
      .execute(
        HttpClientRequest.post(new URL("/machines/ensure", settings.runnerUrl)).pipe(
          HttpClientRequest.bodyText(
            machineEnsureJson.encode({ ...request, modelGatewayUrl: settings.modelGatewayUrl }),
            "application/json",
          ),
        ),
      )
      .pipe(
        Effect.as<MachineStatus>({
          desired: "running",
          actual: "running",
          machineId: "local",
          wake: "warm",
        }),
        Effect.scoped,
        Effect.mapError(
          (cause) => new MachineBackendError({ message: "The local Runner host refused.", cause }),
        ),
      ),
});

/** No backend: Claude and Codex are off. */
export const layerNone = Layer.succeed(MachineBackend, { light: NONE, heavy: NONE });

/** The light class's Cloudflare settings, or null when the thread's object has no container. */
const cloudflareSettings = (env: MachineBackendEnv, container: Container | undefined) => {
  const cloudUrl = nonEmpty(env.CLOUD_URL);
  const modelGatewayUrl = nonEmpty(env.MODEL_GATEWAY_URL);
  return container === undefined || cloudUrl === null || modelGatewayUrl === null
    ? null
    : { container, settings: { cloudUrl, modelGatewayUrl } };
};

/**
 * The backends `env` configures. Needs the thread object's `MachineRecords`.
 * `container` is the object's own (`ctx.container`), where the deployment
 * gives thread objects one; `onExit` hears when it stops on its own.
 */
export const layerFromEnv = (env: MachineBackendEnv, machine: MachineHost = {}) =>
  Layer.effect(
    MachineBackend,
    Effect.gen(function* () {
      const cloudflare = cloudflareSettings(env, machine.container);
      const light =
        cloudflare === null
          ? null
          : makeCloudflareMachineBackend({ ...cloudflare, onExit: machine.onExit ?? (() => {}) });
      const heavy = yield* heavyFromEnv(env);
      if (light === null && heavy === null) return { light: NONE, heavy: NONE };
      return { light: light ?? heavy ?? NONE, heavy: heavy ?? light ?? NONE };
    }),
  );

/** The heavy class's backend `env` configures, or null. */
const heavyFromEnv = (env: MachineBackendEnv) =>
  Effect.gen(function* () {
    const settings = machineSettings(env);
    if (settings === null) {
      if (env.LOCAL_WORKERD === "1" && nonEmpty(env.LOCAL_RUNNER_URL) !== null) {
        yield* Effect.logWarning(
          "LOCAL_RUNNER_URL is set without MODEL_GATEWAY_URL, so Claude and Codex stay off.",
        );
      }
      if (nonEmpty(env.MACHINE_BACKEND) === "boat") {
        yield* Effect.logWarning(
          "MACHINE_BACKEND=boat needs BOAT_API_KEY, CLOUD_URL and MODEL_GATEWAY_URL; Claude and Codex stay off.",
        );
      }
      return null;
    }
    const client = yield* HttpClient.HttpClient;
    if (settings.kind === "local") {
      return makeLocalBackend(client.pipe(HttpClient.filterStatusOk), settings);
    }
    return makeBoatMachineBackend({
      settings,
      api: makeBoatApi(client, { baseUrl: settings.apiUrl, apiKey: settings.apiKey }),
      records: yield* MachineRecords,
      crypto: yield* Crypto.Crypto,
    });
  });
