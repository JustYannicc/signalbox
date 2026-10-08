import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import type { WorkOSOrganization } from "./WorkOSClient.ts";

/**
 * A fake WorkOS for tests of anything that signs in through `WorkOSClient`:
 * the self-hosted server and the cloud.
 */

export const WORKOS_TEST_ENV = {
  T3CODE_WORKOS_CLIENT_ID: "client_test",
  T3CODE_WORKOS_API_BASE_URL: "https://workos.test",
} as const;

export interface WorkOSTestUser {
  readonly id: string;
  readonly email: string;
  readonly first_name?: string | null;
  readonly last_name?: string | null;
  readonly profile_picture_url?: string | null;
}

/**
 * Authorization codes WorkOS will accept. A plain user signs straight in; a
 * `verify` entry makes WorkOS demand email verification with that code
 * (GitHub-style), and `{ fail }` answers with that AuthKit error code.
 */
export type WorkOSCodes = Readonly<
  Record<
    string,
    | WorkOSTestUser
    | { readonly verify: { readonly code: string; readonly user: WorkOSTestUser } }
    | { readonly fail: string }
  >
>;

export const EMAIL_VERIFICATION_GRANT = "urn:workos:oauth:grant-type:email-verification:code";

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Each user's active organizations, in the order WorkOS lists them. */
export type WorkOSMemberships = Readonly<Record<string, ReadonlyArray<WorkOSOrganization>>>;

/** Fake `GET /user_management/organization_memberships`, paged by `limit` and `after`. */
const listMemberships = (url: URL, memberships: WorkOSMemberships): Response => {
  const all = (memberships[url.searchParams.get("user_id") ?? ""] ?? []).map(
    (organization, index) => ({
      id: `om_${index}`,
      organization_id: organization.id,
      organization_name: organization.name,
    }),
  );
  const after = url.searchParams.get("after");
  const start = after ? all.findIndex((membership) => membership.id === after) + 1 : 0;
  const page = all.slice(start, start + Number(url.searchParams.get("limit") ?? 10));
  const last = page.at(-1);
  return Response.json({
    object: "list",
    data: page,
    list_metadata: { after: last && start + page.length < all.length ? last.id : null },
  });
};

/** Fake `GET /user_management/users?email=`, over every user `codes` signs in. */
const findUsers = (url: URL, codes: WorkOSCodes): Response => {
  const email = url.searchParams.get("email");
  const users = Object.values(codes).flatMap((entry) =>
    "fail" in entry ? [] : "verify" in entry ? [entry.verify.user] : [entry],
  );
  return Response.json({
    object: "list",
    data: users.filter((user) => user.email.toLowerCase() === email).slice(0, 1),
    list_metadata: { after: null },
  });
};

/**
 * Fake WorkOS: `POST /user_management/authenticate` (recording each request
 * body), the membership listing, and users by email.
 */
export const workosStubLayer = (
  codes: WorkOSCodes,
  exchanges: Array<Record<string, unknown>> = [],
  memberships: WorkOSMemberships = {},
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(`${request.url}?${UrlParams.toString(request.urlParams)}`);
        if (url.pathname === "/user_management/organization_memberships") {
          return HttpClientResponse.fromWeb(request, listMemberships(url, memberships));
        }
        if (url.pathname === "/user_management/users") {
          return HttpClientResponse.fromWeb(request, findUsers(url, codes));
        }
        const body =
          request.body._tag === "Uint8Array"
            ? decodeBody(new TextDecoder().decode(request.body.body))
            : {};
        exchanges.push({ url: request.url, ...body });
        const signedIn = (user: WorkOSTestUser) =>
          Response.json({ user, access_token: "workos-access", refresh_token: "workos-refresh" });
        const respond = (): Response => {
          if (body.grant_type === EMAIL_VERIFICATION_GRANT) {
            const entry = Object.entries(codes).find(
              ([authCode]) => `pending-${authCode}` === body.pending_authentication_token,
            )?.[1];
            if (!entry || !("verify" in entry)) {
              return Response.json(
                { code: "invalid_pending_authentication_token" },
                { status: 400 },
              );
            }
            return body.code === entry.verify.code
              ? signedIn(entry.verify.user)
              : Response.json({ code: "email_verification_code_invalid" }, { status: 400 });
          }
          const entry = typeof body.code === "string" ? codes[body.code] : undefined;
          if (!entry) return Response.json({ error: "invalid_grant" }, { status: 400 });
          if ("fail" in entry) {
            return Response.json(
              { code: entry.fail, message: "nope", pending_authentication_token: "secret" },
              { status: 403 },
            );
          }
          if ("verify" in entry) {
            return Response.json(
              {
                code: "email_verification_required",
                message: "Email ownership must be verified before authentication.",
                pending_authentication_token: `pending-${String(body.code)}`,
                email: entry.verify.user.email,
                email_verification_id: "email_verification_1",
              },
              { status: 403 },
            );
          }
          return signedIn(entry);
        };
        return HttpClientResponse.fromWeb(request, respond());
      }),
    ),
  );
