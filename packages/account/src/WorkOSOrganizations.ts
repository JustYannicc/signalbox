import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * Reads the personal organization WorkOS keeps for a user under the external ID
 * `personal:<userId>`. Read-only: nothing here creates organizations or
 * memberships.
 *
 * Never log the request or the raw response: the request carries the API key.
 */

export interface WorkOSPersonalOrganizationConfig {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

export class WorkOSPersonalOrganizationError extends Schema.TaggedError<WorkOSPersonalOrganizationError>()(
  "WorkOSPersonalOrganizationError",
  {
    operation: Schema.Literal("resolve"),
    /** HTTP status, absent when the request never got a response. */
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `WorkOS personal organization ${this.operation} failed (${this.status ?? "no response"}).`;
  }
}

// Callers hide the personal organization by this ID, so a blank or padded one must not pass.
const OrganizationBody = Schema.Struct({
  id: Schema.NonEmptyString.check(Schema.isTrimmed()),
  external_id: Schema.String,
});

const resolveError = (status?: number) =>
  new WorkOSPersonalOrganizationError({
    operation: "resolve",
    ...(status === undefined ? {} : { status }),
  });

/**
 * `GET /organizations/external_id/:external_id`: the user's personal
 * organization ID, or null when WorkOS answers 404. Any other failure, or an
 * organization under a different external ID, is an error, never null.
 */
export const resolvePersonalOrganization = Effect.fn("WorkOSPersonalOrganization.resolve")(
  function* (config: WorkOSPersonalOrganizationConfig, userId: string) {
    const externalId = `personal:${userId}`;
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(
          new URL(
            `/organizations/external_id/${encodeURIComponent(externalId)}`,
            config.apiBaseUrl,
          ),
        ).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(Redacted.value(config.apiKey)),
        ),
      )
      .pipe(Effect.mapError(() => resolveError()));
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      return yield* resolveError(response.status);
    }

    const organization = yield* HttpClientResponse.schemaBodyJson(OrganizationBody)(response).pipe(
      Effect.mapError(() => resolveError(response.status)),
    );
    if (organization.external_id !== externalId) return yield* resolveError(response.status);
    return organization.id;
  },
);
