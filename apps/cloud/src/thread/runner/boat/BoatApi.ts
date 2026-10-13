import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type HttpClient, HttpClientRequest } from "effect/http";

/**
 * The parts of boat's Public API v1 (https://docs.boat.dev/api/v1) a thread's
 * machine needs. A boat "sandbox" is one VM with a disk that survives stop
 * and resume. Only the fields used here are decoded; boat adds fields freely.
 */

export class BoatApiError extends Schema.TaggedError<BoatApiError>()("BoatApiError", {
  operation: Schema.String,
  /** HTTP status, or 0 when no response arrived. */
  status: Schema.Number,
  /** boat's error code, e.g. `idempotency_in_progress`. */
  code: Schema.NullOr(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const BoatSandbox = Schema.Struct({
  id: Schema.String,
  /** `provisioning`, `ready`, `archived`… Unknown future states stay strings. */
  state: Schema.String,
  error: Schema.optional(Schema.NullOr(Schema.String)),
  /** Outcome of the create-time `setupScript`. */
  setupStatus: Schema.optional(Schema.NullOr(Schema.String)),
  /** Why the setup script failed, for the turn's diagnostics. */
  setupError: Schema.optional(Schema.NullOr(Schema.String)),
  archiveAfter: Schema.optional(Schema.NullOr(Schema.String)),
});
export type BoatSandbox = typeof BoatSandbox.Type;

const decodeSandboxBody = Schema.decodeUnknownEffect(Schema.Struct({ sandbox: BoatSandbox }));
const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
);

export interface BoatCreateRequest {
  readonly type: string;
  readonly ttlSeconds: number;
  /** Runs once, in the background, after the sandbox is first ready. */
  readonly setupScript: string;
}

export interface BoatApi {
  /** Retried with the same `idempotencyKey`, returns the sandbox the first call created. */
  readonly create: (
    request: BoatCreateRequest,
    idempotencyKey: string,
  ) => Effect.Effect<BoatSandbox, BoatApiError>;
  /** Null when boat no longer knows the sandbox. */
  readonly get: (id: string) => Effect.Effect<BoatSandbox | null, BoatApiError>;
  readonly resume: (id: string) => Effect.Effect<void, BoatApiError>;
  /** Sets the sandbox's auto-stop to `ttlSeconds` from now. */
  readonly setTtl: (id: string, ttlSeconds: number) => Effect.Effect<void, BoatApiError>;
  /** Snapshots the disk and stops the machine. Asking again while it stops is a no-op. */
  readonly stop: (id: string) => Effect.Effect<void, BoatApiError>;
  /** Deletes the sandbox and its snapshots for good. */
  readonly remove: (id: string) => Effect.Effect<void, BoatApiError>;
  /** Writes `content` to `path` (under /home/user) on a running sandbox. */
  readonly writeFile: (
    id: string,
    path: string,
    content: string,
  ) => Effect.Effect<void, BoatApiError>;
}

export const makeBoatApi = (
  client: HttpClient.HttpClient,
  options: { readonly baseUrl: string; readonly apiKey: Redacted.Redacted<string> },
): BoatApi => {
  const base = options.baseUrl.replace(/\/+$/, "");
  const url = (path: string) => `${base}${path}`;

  /** Sends `request`; a non-2xx answer fails with boat's code and message. */
  const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    client
      .execute(
        request.pipe(HttpClientRequest.bearerToken(options.apiKey), HttpClientRequest.acceptJson),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new BoatApiError({
              operation,
              status: 0,
              code: null,
              message: "boat did not answer.",
              cause,
            }),
        ),
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
            if (response.status >= 200 && response.status < 300) return body;
            const error = decodeErrorBody(body);
            const details = error._tag === "Some" ? error.value : {};
            return yield* new BoatApiError({
              operation,
              status: response.status,
              code: details.code ?? null,
              message: details.message ?? `boat answered ${response.status}.`,
            });
          }),
        ),
        Effect.scoped,
      );

  const sandboxOf = (operation: string) => (body: unknown) =>
    decodeSandboxBody(body).pipe(
      Effect.map((decoded) => decoded.sandbox),
      Effect.mapError(
        (cause) =>
          new BoatApiError({
            operation,
            status: 200,
            code: null,
            message: "boat sent an unreadable sandbox.",
            cause,
          }),
      ),
    );

  const sandboxPath = (id: string, rest = "") => url(`/sandboxes/${encodeURIComponent(id)}${rest}`);

  return {
    create: (request, idempotencyKey) =>
      send(
        "create",
        HttpClientRequest.post(url("/sandboxes")).pipe(
          HttpClientRequest.setHeader("Idempotency-Key", idempotencyKey),
          // No-env: none of the account's secrets or credentials reach the machine.
          HttpClientRequest.bodyJsonUnsafe({ ...request, noEnv: true }),
        ),
      ).pipe(Effect.flatMap(sandboxOf("create"))),
    get: (id) =>
      send("get", HttpClientRequest.get(sandboxPath(id))).pipe(
        Effect.flatMap(sandboxOf("get")),
        Effect.catchIf(
          (error) => error.status === 404,
          () => Effect.succeed(null),
        ),
      ),
    resume: (id) =>
      Effect.asVoid(
        send(
          "resume",
          HttpClientRequest.post(sandboxPath(id, "/resume")).pipe(
            HttpClientRequest.bodyJsonUnsafe({}),
          ),
        ),
      ),
    setTtl: (id, ttlSeconds) =>
      Effect.asVoid(
        send(
          "setTtl",
          HttpClientRequest.patch(sandboxPath(id)).pipe(
            HttpClientRequest.bodyJsonUnsafe({ ttlSeconds }),
          ),
        ),
      ),
    stop: (id) =>
      Effect.asVoid(
        send(
          "stop",
          HttpClientRequest.post(sandboxPath(id, "/stop")).pipe(
            HttpClientRequest.bodyJsonUnsafe({}),
          ),
        ),
      ),
    remove: (id) =>
      Effect.asVoid(
        send(
          "delete",
          HttpClientRequest.make("DELETE")(sandboxPath(id)).pipe(
            // boat refuses a delete that does not name its own target.
            HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", id),
          ),
        ),
      ),
    writeFile: (id, path, content) =>
      Effect.asVoid(
        send(
          "writeFile",
          HttpClientRequest.put(sandboxPath(id, "/files")).pipe(
            HttpClientRequest.bodyJsonUnsafe({ path, content }),
          ),
        ),
      ),
  };
};
