/**
 * Credential files Signalbox writes into the account hub.
 *
 * `chatgpt-siwc` is read by Signalbox's own CLIProxyAPI plugin
 * (native/cliproxyapi-chatgpt). Its field names are that plugin's contract:
 * change both together.
 *
 * @module accountHub/hubCredentials
 */
import type { ChatGptTransferredProfile } from "@t3tools/contracts";

export const ACCOUNT_HUB_CHATGPT_TYPE = "chatgpt-siwc";

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9@.+-]+/gu, "-")
    .replace(/^[.-]+|-+$/gu, "")
    .slice(0, 96);

/**
 * One file per ChatGPT account. Named by email so signing the same account in
 * again replaces its expired credential instead of adding a duplicate.
 */
export function chatGptCredentialFile(profile: ChatGptTransferredProfile, hostId: string) {
  const { credentials } = profile;
  const key = (credentials.email && slug(credentials.email)) || slug(credentials.clientId);
  return {
    name: `${ACCOUNT_HUB_CHATGPT_TYPE}-${key}.json`,
    content: {
      type: ACCOUNT_HUB_CHATGPT_TYPE,
      client_id: credentials.clientId,
      ext_agent_host_id: hostId,
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      id_token: credentials.idToken,
      expires_at: Math.floor(credentials.expiresAt / 1000),
      ...(credentials.earliestRefreshAt === null
        ? {}
        : { earliest_refresh_at: Math.floor(credentials.earliestRefreshAt / 1000) }),
      scopes: credentials.scopes,
      ...(credentials.email ? { email: credentials.email } : {}),
    },
  } as const;
}
