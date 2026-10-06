import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

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

/** Fake `POST /user_management/authenticate`. Records each request body. */
export const workosStubLayer = (
  codes: WorkOSCodes,
  exchanges: Array<Record<string, unknown>> = [],
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
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
