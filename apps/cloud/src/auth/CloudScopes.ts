import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
} from "@t3tools/contracts";

const NOT_IN_THE_CLOUD: ReadonlySet<AuthEnvironmentScope> = new Set([
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayWriteScope,
]);

/**
 * What a cloud session, key or agent may hold: the standard client scopes without access
 * and relay management. Upstream grants those by default because a shell on the same
 * machine reaches them anyway; nothing in the cloud does, so no credential may claim them.
 */
export const CLOUD_CLIENT_SCOPES: ReadonlyArray<AuthEnvironmentScope> =
  AuthStandardClientScopes.filter((scope) => !NOT_IN_THE_CLOUD.has(scope));
