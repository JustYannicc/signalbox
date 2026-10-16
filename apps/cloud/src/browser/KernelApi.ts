import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type HttpClient, HttpClientRequest } from "effect/http";

/**
 * The parts of Kernel's API (https://www.kernel.sh/docs) the person's
 * browser needs (#574): profiles and headless browsers.
 * Only the fields used here are decoded; Kernel adds fields freely. A call
 * that gets no answer within `TIMEOUT` fails, so nothing waits on Kernel for
 * long. A browser's CDP URL carries its own credential: never log it.
 */

export const KERNEL_API_URL = "https://api.onkernel.com";
const TIMEOUT = Duration.seconds(30);

export class KernelApiError extends Schema.TaggedError<KernelApiError>()("KernelApiError", {
  operation: Schema.String,
  /** HTTP status, or 0 when no answer arrived. */
  status: Schema.Number,
  /** Kernel's error code, e.g. `org_limit_exceeded`. */
  code: Schema.NullOr(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const KernelBrowser = Schema.Struct({
  session_id: Schema.String,
  cdp_ws_url: Schema.String,
  /** Set once Kernel deleted the browser. */
  deleted_at: Schema.optional(Schema.NullOr(Schema.String)),
});
export type KernelBrowser = typeof KernelBrowser.Type;

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
);

/** `POST /browsers` as the person's browser asks for it. */
export interface KernelBrowserRequest {
  readonly stealth: boolean;
  readonly headless: boolean;
  readonly timeout_seconds: number;
  readonly profile: { readonly name: string; readonly save_changes: boolean };
  readonly tags: Readonly<Record<string, string>>;
}

export interface KernelApi {
  /** Creates the profile; one that already exists is fine. */
  readonly ensureProfile: (name: string) => Effect.Effect<void, KernelApiError>;
  readonly createBrowser: (
    request: KernelBrowserRequest,
  ) => Effect.Effect<KernelBrowser, KernelApiError>;
  /** Null once Kernel no longer runs the browser. */
  readonly getBrowser: (id: string) => Effect.Effect<KernelBrowser | null, KernelApiError>;
  /** Deletes the browser, which saves its profile when it writes one. A gone one is fine. */
  readonly deleteBrowser: (id: string) => Effect.Effect<void, KernelApiError>;
}

export const makeKernelApi = (
  client: HttpClient.HttpClient,
  options: { readonly apiKey: Redacted.Redacted<string>; readonly baseUrl?: string },
): KernelApi => {
  const base = (options.baseUrl ?? KERNEL_API_URL).replace(/\/+$/, "");
  const url = (path: string) => `${base}${path}`;

  /** Sends `request`; a non-2xx answer fails with Kernel's code and message. */
  const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    client
      .execute(
        request.pipe(HttpClientRequest.bearerToken(options.apiKey), HttpClientRequest.acceptJson),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new KernelApiError({
              operation,
              status: 0,
              code: null,
              message: "Kernel did not answer.",
              cause,
            }),
        ),
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
            if (response.status >= 200 && response.status < 300) return body;
            const error = decodeErrorBody(body);
            const details = error._tag === "Some" ? error.value : {};
            return yield* new KernelApiError({
              operation,
              status: response.status,
              code: details.code ?? null,
              message: details.message ?? `Kernel answered ${response.status}.`,
            });
          }),
        ),
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () =>
            Effect.fail(
              new KernelApiError({
                operation,
                status: 0,
                code: null,
                message: `Kernel did not answer within ${Duration.format(TIMEOUT)}.`,
              }),
            ),
        }),
      );

  const decoded =
    <S extends Schema.Top & { readonly DecodingServices: never }>(operation: string, schema: S) =>
    (body: unknown) =>
      Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(
          (cause) =>
            new KernelApiError({
              operation,
              status: 200,
              code: null,
              message: "Kernel sent an unreadable answer.",
              cause,
            }),
        ),
      );

  const browserPath = (id: string) => url(`/browsers/${encodeURIComponent(id)}`);
  const gone = (error: KernelApiError) => error.status === 404;

  return {
    ensureProfile: (name) =>
      send(
        "createProfile",
        HttpClientRequest.post(url("/profiles")).pipe(HttpClientRequest.bodyJsonUnsafe({ name })),
      ).pipe(
        Effect.asVoid,
        Effect.catchIf(
          (error) => error.status === 409,
          () => Effect.void,
        ),
      ),
    createBrowser: (request) =>
      send(
        "createBrowser",
        HttpClientRequest.post(url("/browsers")).pipe(HttpClientRequest.bodyJsonUnsafe(request)),
      ).pipe(Effect.flatMap(decoded("createBrowser", KernelBrowser))),
    getBrowser: (id) =>
      send("getBrowser", HttpClientRequest.get(browserPath(id))).pipe(
        Effect.flatMap(decoded("getBrowser", KernelBrowser)),
        Effect.map((browser) => (browser.deleted_at ? null : browser)),
        Effect.catchIf(gone, () => Effect.succeed(null)),
      ),
    deleteBrowser: (id) =>
      send("deleteBrowser", HttpClientRequest.make("DELETE")(browserPath(id))).pipe(
        Effect.asVoid,
        Effect.catchIf(gone, () => Effect.void),
      ),
  };
};
