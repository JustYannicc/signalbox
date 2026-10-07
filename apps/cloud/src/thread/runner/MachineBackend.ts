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
 */

export interface MachineBackendEnv {
  /** Set by `vp run dev` only. */
  readonly LOCAL_WORKERD?: string;
  /** A local Runner host, e.g. `http://localhost:8790`. */
  readonly LOCAL_RUNNER_URL?: string;
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
      | ((request: MachineEnsureRequest) => Effect.Effect<void, MachineBackendError>)
      | null;
  }
>()("@signalbox/cloud/thread/runner/MachineBackend") {}

/** The local Runner host's URL, when the environment configures one. */
export const localRunnerUrl = (env: MachineBackendEnv) =>
  env.LOCAL_WORKERD === "1" && env.LOCAL_RUNNER_URL !== undefined && env.LOCAL_RUNNER_URL !== ""
    ? env.LOCAL_RUNNER_URL
    : null;

export const layerFromEnv = (env: MachineBackendEnv) =>
  Layer.effect(
    MachineBackend,
    Effect.gen(function* () {
      const url = localRunnerUrl(env);
      if (url === null) return MachineBackend.of({ ensure: null });
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      return MachineBackend.of({
        ensure: (request) =>
          client
            .execute(
              HttpClientRequest.post(new URL("/machines/ensure", url)).pipe(
                HttpClientRequest.bodyText(machineEnsureJson.encode(request), "application/json"),
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
