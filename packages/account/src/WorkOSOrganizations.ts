import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export interface WorkOSPersonalOrganizationConfig {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

type Operation = "resolve" | "createOrganization" | "listMemberships" | "createMembership";

export class WorkOSPersonalOrganizationError extends Schema.TaggedError<WorkOSPersonalOrganizationError>()(
  "WorkOSPersonalOrganizationError",
  {
    operation: Schema.Union([
      Schema.Literal("resolve"),
      Schema.Literal("createOrganization"),
      Schema.Literal("listMemberships"),
      Schema.Literal("createMembership"),
    ]),
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
const MembershipBody = Schema.Struct({
  id: Schema.String,
  organization_id: Schema.String,
  user_id: Schema.String,
  status: Schema.Literal("active"),
});
const MembershipPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      organization_id: Schema.String,
      user_id: Schema.String,
      status: Schema.String,
    }),
  ),
  list_metadata: Schema.Struct({ after: Schema.optional(Schema.NullOr(Schema.String)) }),
});

const MEMBERSHIP_PAGE_SIZE = 100;
const MAX_MEMBERSHIP_PAGES = 20;

const isOk = (status: number) => status >= 200 && status < 300;
const error = (operation: Operation, status?: number) =>
  new WorkOSPersonalOrganizationError({ operation, ...(status === undefined ? {} : { status }) });

const execute = (operation: Operation, request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(Effect.mapError(() => error(operation)));
  });

const authenticatedGet = (config: WorkOSPersonalOrganizationConfig, url: URL) =>
  HttpClientRequest.get(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(Redacted.value(config.apiKey)),
  );

const authenticatedPost = (
  config: WorkOSPersonalOrganizationConfig,
  url: URL,
  body: Readonly<Record<string, string>>,
) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(Redacted.value(config.apiKey)),
    HttpClientRequest.bodyJsonUnsafe(body),
  );

const externalIdFor = (userId: string) => `personal:${userId}`;

const readOrganization = Effect.fn("WorkOSPersonalOrganization.read")(function* (
  config: WorkOSPersonalOrganizationConfig,
  externalId: string,
) {
  const response = yield* execute(
    "resolve",
    authenticatedGet(
      config,
      new URL(`/organizations/external_id/${encodeURIComponent(externalId)}`, config.apiBaseUrl),
    ),
  );
  if (response.status === 404) return null;
  if (!isOk(response.status)) return yield* error("resolve", response.status);

  const organization = yield* HttpClientResponse.schemaBodyJson(OrganizationBody)(response).pipe(
    Effect.mapError(() => error("resolve", response.status)),
  );
  if (organization.external_id !== externalId) return yield* error("resolve", response.status);
  return organization.id;
});

/** Resolves only the organization WorkOS associates with this user's external ID. */
export const resolvePersonalOrganization = Effect.fn("WorkOSPersonalOrganization.resolve")(
  function* (config: WorkOSPersonalOrganizationConfig, userId: string) {
    return yield* readOrganization(config, externalIdFor(userId));
  },
);

const createOrganization = Effect.fn("WorkOSPersonalOrganization.create")(function* (
  config: WorkOSPersonalOrganizationConfig,
  externalId: string,
) {
  const result = yield* Effect.result(
    Effect.gen(function* () {
      const response = yield* execute(
        "createOrganization",
        authenticatedPost(config, new URL("/organizations", config.apiBaseUrl), {
          name: "Personal",
          external_id: externalId,
        }),
      );
      if (!isOk(response.status)) return yield* error("createOrganization", response.status);

      const organization = yield* HttpClientResponse.schemaBodyJson(OrganizationBody)(
        response,
      ).pipe(Effect.mapError(() => error("createOrganization", response.status)));
      if (organization.external_id !== externalId) {
        return yield* error("createOrganization", response.status);
      }
      return organization.id;
    }),
  );
  if (Result.isSuccess(result)) return result.success;

  // A concurrent worker may have won, or this request may have completed before its response was lost.
  const existing = yield* readOrganization(config, externalId);
  if (existing !== null) return existing;
  return yield* result.failure;
});

const hasActiveMembership = Effect.fn("WorkOSPersonalOrganization.hasActiveMembership")(function* (
  config: WorkOSPersonalOrganizationConfig,
  organizationId: string,
  userId: string,
) {
  let after: string | undefined;
  for (let page = 0; page < MAX_MEMBERSHIP_PAGES; page++) {
    const url = new URL("/user_management/organization_memberships", config.apiBaseUrl);
    url.searchParams.set("organization_id", organizationId);
    url.searchParams.set("user_id", userId);
    url.searchParams.set("statuses", "active");
    url.searchParams.set("limit", String(MEMBERSHIP_PAGE_SIZE));
    if (after) url.searchParams.set("after", after);

    const response = yield* execute("listMemberships", authenticatedGet(config, url));
    if (!isOk(response.status)) return yield* error("listMemberships", response.status);
    const body = yield* HttpClientResponse.schemaBodyJson(MembershipPage)(response).pipe(
      Effect.mapError(() => error("listMemberships", response.status)),
    );
    if (
      body.data.some(
        (membership) =>
          membership.organization_id === organizationId &&
          membership.user_id === userId &&
          membership.status === "active",
      )
    ) {
      return true;
    }
    after = body.list_metadata.after ?? undefined;
    if (!after) return false;
  }
  return yield* error("listMemberships");
});

const createMembership = Effect.fn("WorkOSPersonalOrganization.createMembership")(function* (
  config: WorkOSPersonalOrganizationConfig,
  organizationId: string,
  userId: string,
) {
  const result = yield* Effect.result(
    Effect.gen(function* () {
      const response = yield* execute(
        "createMembership",
        authenticatedPost(
          config,
          new URL("/user_management/organization_memberships", config.apiBaseUrl),
          { organization_id: organizationId, user_id: userId },
        ),
      );
      if (!isOk(response.status)) return yield* error("createMembership", response.status);

      const membership = yield* HttpClientResponse.schemaBodyJson(MembershipBody)(response).pipe(
        Effect.mapError(() => error("createMembership", response.status)),
      );
      if (membership.organization_id !== organizationId || membership.user_id !== userId) {
        return yield* error("createMembership", response.status);
      }
    }),
  );
  if (Result.isSuccess(result)) return;

  // The list is the authority for whether a duplicate create already succeeded.
  if (yield* hasActiveMembership(config, organizationId, userId)) return;
  return yield* result.failure;
});

/** Ensures a personal organization and active membership, returning its WorkOS ID. */
export const ensurePersonalOrganization = Effect.fn("WorkOSPersonalOrganization.ensure")(function* (
  config: WorkOSPersonalOrganizationConfig,
  userId: string,
) {
  const externalId = externalIdFor(userId);
  const existing = yield* readOrganization(config, externalId);
  const organizationId = existing ?? (yield* createOrganization(config, externalId));

  if (!(yield* hasActiveMembership(config, organizationId, userId))) {
    yield* createMembership(config, organizationId, userId);
  }
  return organizationId;
});
