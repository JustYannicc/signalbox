import * as Effect from "effect/Effect";

import * as WorkOSClient from "./WorkOSClient.ts";
import * as WorkOSOrganizations from "./WorkOSOrganizations.ts";

/** Only an authoritative personal organization can pin hosted email sign-in. */
export const emailOrganization = Effect.fn("WorkOSPersonalAuthentication.emailOrganization")(
  function* (config: WorkOSClient.WorkOSConfig, email: string) {
    const { apiKey } = config;
    if (!apiKey) return null;
    const user = yield* WorkOSClient.findUserByEmail({ ...config, apiKey }, email);
    if (!user) return null;
    const organizationId = yield* WorkOSOrganizations.resolvePersonalOrganization(
      { ...config, apiKey },
      user.id,
    );
    return organizationId ? { userId: user.id, organizationId } : null;
  },
);

/** The organization choice belongs to Signalbox, never to the person signing in. */
export const authenticate = Effect.fn("WorkOSPersonalAuthentication.authenticate")(function* (
  config: WorkOSClient.WorkOSConfig,
  grant: WorkOSClient.WorkOSGrant,
) {
  return yield* WorkOSClient.authenticate(config, grant).pipe(
    Effect.catchTags({
      WorkOSOrganizationSelectionRequired: (required) =>
        Effect.gen(function* () {
          if (!config.apiKey) return yield* new WorkOSClient.WorkOSAuthenticateError({});
          const organizationId = yield* WorkOSOrganizations.ensurePersonalOrganization(
            { ...config, apiKey: config.apiKey },
            required.user.id,
          ).pipe(Effect.mapError(() => new WorkOSClient.WorkOSAuthenticateError({})));
          const user = yield* WorkOSClient.authenticate(config, {
            kind: "organization-selection",
            organizationId,
            pendingToken: required.pendingToken,
          }).pipe(
            Effect.catchTags({
              WorkOSOrganizationSelectionRequired: () =>
                Effect.fail(
                  new WorkOSClient.WorkOSAuthenticateError({ error: "invalid_response" }),
                ),
            }),
          );
          if (user.id !== required.user.id) {
            return yield* new WorkOSClient.WorkOSAuthenticateError({ error: "invalid_response" });
          }
          return user;
        }),
    }),
  );
});
