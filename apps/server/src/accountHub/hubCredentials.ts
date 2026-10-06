/**
 * Credential files Signalbox writes into the account hub.
 *
 * `chatgpt-siwc` is read by Signalbox's own CLIProxyAPI plugin
 * (native/cliproxyapi-chatgpt). Its field names are that plugin's contract:
 * change both together.
 *
 * @module accountHub/hubCredentials
 */
import * as NodeCrypto from "node:crypto";

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

/** Cursor accounts: kept in the hub so they go with the pool, though the hub never routes them. */
export const CURSOR_CREDENTIAL_TYPE = "cursor";

export function cursorCredentialFile(credential: {
  readonly apiKey: string;
  readonly email?: string | undefined;
  readonly backendUrl?: string | undefined;
  readonly apiKeyExpiresAtMs?: number | undefined;
  readonly createdAtMs: number;
}) {
  const key =
    (credential.email && slug(credential.email)) ||
    NodeCrypto.createHash("sha256").update(credential.apiKey).digest("hex").slice(0, 12);
  return {
    name: `${CURSOR_CREDENTIAL_TYPE}-${key}.json`,
    content: {
      type: CURSOR_CREDENTIAL_TYPE,
      api_key: credential.apiKey,
      created_at_ms: credential.createdAtMs,
      ...(credential.email ? { email: credential.email } : {}),
      ...(credential.backendUrl ? { backend_url: credential.backendUrl } : {}),
      ...(credential.apiKeyExpiresAtMs === undefined
        ? {}
        : { api_key_expires_at_ms: credential.apiKeyExpiresAtMs }),
    },
  } as const;
}
