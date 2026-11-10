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
    | {
        readonly select: {
          readonly user: WorkOSTestUser;
          readonly organizationId: string;
          readonly verifyCode?: string;
        };
      }
  >
>;

export const EMAIL_VERIFICATION_GRANT = "urn:workos:oauth:grant-type:email-verification:code";
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const ORGANIZATION_SELECTION_GRANT = "urn:workos:oauth:grant-type:organization-selection";
export const MAGIC_AUTH_GRANT = "urn:workos:oauth:grant-type:magic-auth:code";

/** What the fake's device authorization hands out; approve it by adding a `codes` entry for it. */
export const TEST_DEVICE_CODE = "device-1";

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * One active membership. `roleSlugs` are sent as WorkOS does, as `role` (the
 * first) and `roles`; `wire` sends its fields instead, for other shapes.
 */
export interface WorkOSTestMembership extends WorkOSOrganization {
  readonly wire?: { readonly role?: unknown; readonly roles?: unknown };
}

/** Each user's active organizations, in the order WorkOS lists them. */
export type WorkOSMemberships = Readonly<Record<string, ReadonlyArray<WorkOSTestMembership>>>;

const roleFields = ({ roleSlugs = [], wire }: WorkOSTestMembership) => {
  if (wire) return wire;
  const [first] = roleSlugs;
  return first === undefined
    ? {}
    : { role: { slug: first }, roles: roleSlugs.map((slug) => ({ slug })) };
};

/** Fake `GET /user_management/organization_memberships`, paged by `limit` and `after`. */
const listMemberships = (url: URL, memberships: WorkOSMemberships): Response => {
  const all = (memberships[url.searchParams.get("user_id") ?? ""] ?? [])
    .filter(
      (organization) =>
        !url.searchParams.has("organization_id") ||
        organization.id === url.searchParams.get("organization_id"),
    )
    .map((organization, index) => ({
      id: `om_${index}`,
      organization_id: organization.id,
      organization_name: organization.name,
      user_id: url.searchParams.get("user_id"),
      status: "active",
      ...roleFields(organization),
    }));
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
    "fail" in entry
      ? []
      : "verify" in entry
        ? [entry.verify.user]
        : "select" in entry
          ? [entry.select.user]
          : [entry],
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
        if (url.pathname.startsWith("/organizations/external_id/")) {
          const externalId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
          const entry = Object.values(codes).find(
            (entry) => "select" in entry && externalId === `personal:${entry.select.user.id}`,
          );
          return HttpClientResponse.fromWeb(
            request,
            entry && "select" in entry
              ? Response.json({
                  id: entry.select.organizationId,
                  name: "Personal",
                  external_id: externalId,
                })
              : Response.json({ code: "not_found" }, { status: 404 }),
          );
        }
        if (url.pathname === "/user_management/authorize/device") {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              device_code: TEST_DEVICE_CODE,
              user_code: "ABCD-EFGH",
              verification_uri: "https://authkit.test/device",
              verification_uri_complete: "https://authkit.test/device?user_code=ABCD-EFGH",
              expires_in: 300,
              interval: 5,
            }),
          );
        }
        const body =
          request.body._tag === "Uint8Array"
            ? decodeBody(new TextDecoder().decode(request.body.body))
            : {};
        exchanges.push({ url: request.url, ...body });
        if (url.pathname === "/user_management/magic_auth") {
          return HttpClientResponse.fromWeb(request, Response.json({ id: "magic_auth_test" }));
        }
        const signedIn = (user: WorkOSTestUser) =>
          Response.json({ user, access_token: "workos-access", refresh_token: "workos-refresh" });
        const selectionRequired = (authCode: string, user: WorkOSTestUser) =>
          Response.json(
            {
              code: "organization_selection_required",
              pending_authentication_token: `selection-${authCode}`,
              user,
              organizations: memberships[user.id] ?? [],
            },
            { status: 400 },
          );
        const respond = (): Response => {
          if (body.grant_type === MAGIC_AUTH_GRANT) {
            const entry = typeof body.code === "string" ? codes[body.code] : undefined;
            if (entry && "select" in entry && entry.select.user.email === body.email) {
              return selectionRequired(String(body.code), entry.select.user);
            }
            return entry &&
              !("select" in entry) &&
              !("verify" in entry) &&
              !("fail" in entry) &&
              entry.email === body.email
              ? signedIn(entry)
              : Response.json({ code: "magic_auth_code_invalid" }, { status: 400 });
          }
          if (body.grant_type === ORGANIZATION_SELECTION_GRANT) {
            const entry = Object.entries(codes).find(
              ([authCode]) => `selection-${authCode}` === body.pending_authentication_token,
            )?.[1];
            return entry &&
              "select" in entry &&
              body.organization_id === entry.select.organizationId
              ? signedIn(entry.select.user)
              : Response.json({ code: "invalid_pending_authentication_token" }, { status: 400 });
          }
          if (body.grant_type === EMAIL_VERIFICATION_GRANT) {
            const entry = Object.entries(codes).find(
              ([authCode]) => `pending-${authCode}` === body.pending_authentication_token,
            )?.[1];
            if (entry && "select" in entry) {
              return body.code === entry.select.verifyCode
                ? selectionRequired(
                    String(body.pending_authentication_token).slice("pending-".length),
                    entry.select.user,
                  )
                : Response.json({ code: "email_verification_code_invalid" }, { status: 400 });
            }
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
          if (body.grant_type === DEVICE_CODE_GRANT) {
            // Not approved yet, until `codes` has a plain user for the device code.
            const approved =
              typeof body.device_code === "string" ? codes[body.device_code] : undefined;
            if (approved && "select" in approved) {
              return selectionRequired(String(body.device_code), approved.select.user);
            }
            return approved &&
              !("fail" in approved) &&
              !("verify" in approved) &&
              !("select" in approved)
              ? signedIn(approved)
              : Response.json({ error: "authorization_pending" }, { status: 400 });
          }
          const entry = typeof body.code === "string" ? codes[body.code] : undefined;
          if (!entry) return Response.json({ error: "invalid_grant" }, { status: 400 });
          if ("fail" in entry) {
            return Response.json(
              { code: entry.fail, message: "nope", pending_authentication_token: "secret" },
              { status: 403 },
            );
          }
          if ("select" in entry && !entry.select.verifyCode) {
            return selectionRequired(String(body.code), entry.select.user);
          }
          if ("select" in entry) {
            return Response.json(
              {
                code: "email_verification_required",
                pending_authentication_token: `pending-${String(body.code)}`,
                email: entry.select.user.email,
              },
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
