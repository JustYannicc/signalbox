import {
  machineEnsureJson,
  type MachineEnsureRequest,
} from "@signalbox/runner-protocol/RunnerProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * Where a thread's machines come from. A thread asks for one machine per
 * generation; asking again for the same generation is a no-op, so retries are
 * safe. Real backends (Cloudflare Containers, boat) come with #130 and #134.
 *
 * `local` is for development only: a Runner host on the developer's own
 * machine (`node apps/server/src/signalbox/runner/main.ts`), reached at `LOCAL_RUNNER_URL`. It
 * only counts under `LOCAL_WORKERD`, so a deployed Worker never calls a URL
 * someone left in its vars.
 *
 * Machines hold no provider keys, so a backend is only usable together with a
 * ModelGateway (`MODEL_GATEWAY_URL`), which every machine is told about.
 */

export interface MachineBackendEnv {
  /** Set by `vp run dev` only. */
  readonly LOCAL_WORKERD?: string;
  /** A local Runner host, e.g. `http://localhost:8790`. */
  readonly LOCAL_RUNNER_URL?: string;
  /** The ModelGateway Worker's origin, e.g. `http://127.0.0.1:8788`. */
  readonly MODEL_GATEWAY_URL?: string;
}

export class MachineBackendError extends Schema.TaggedError<MachineBackendError>()(
  "MachineBackendError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class MachineBackend extends Context.Service<
  MachineBackend,
  {
    /** Null when this cloud has no backend, so it cannot run Claude or Codex. */
    readonly ensure:
      | ((
          request: Omit<MachineEnsureRequest, "modelGatewayUrl">,
        ) => Effect.Effect<void, MachineBackendError>)
      | null;
  }
>()("@signalbox/cloud/thread/runner/MachineBackend") {}

const nonEmpty = (value: string | undefined) =>
  value === undefined || value === "" ? null : value;

/** The local Runner host and the gateway its harnesses use, when the environment configures both. */
export const localMachines = (env: MachineBackendEnv) => {
  const runnerUrl = env.LOCAL_WORKERD === "1" ? nonEmpty(env.LOCAL_RUNNER_URL) : null;
  const modelGatewayUrl = nonEmpty(env.MODEL_GATEWAY_URL);
  return runnerUrl === null || modelGatewayUrl === null ? null : { runnerUrl, modelGatewayUrl };
};

export const layerFromEnv = (env: MachineBackendEnv) =>
  Layer.effect(
    MachineBackend,
    Effect.gen(function* () {
      const machines = localMachines(env);
      if (machines === null) {
        if (env.LOCAL_WORKERD === "1" && nonEmpty(env.LOCAL_RUNNER_URL) !== null) {
          yield* Effect.logWarning(
            "LOCAL_RUNNER_URL is set without MODEL_GATEWAY_URL, so Claude and Codex stay off.",
          );
        }
        return MachineBackend.of({ ensure: null });
      }
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      return MachineBackend.of({
        ensure: (request) =>
          client
            .execute(
              HttpClientRequest.post(new URL("/machines/ensure", machines.runnerUrl)).pipe(
                HttpClientRequest.bodyText(
                  machineEnsureJson.encode({
                    ...request,
                    modelGatewayUrl: machines.modelGatewayUrl,
                  }),
                  "application/json",
                ),
              ),
            )
            .pipe(
              Effect.asVoid,
              Effect.scoped,
              Effect.mapError(
                (cause) =>
                  new MachineBackendError({ message: "The local Runner host refused.", cause }),
              ),
            ),
      });
    }),
  );
