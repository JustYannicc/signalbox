/**
 * Credential files Signalbox writes into the account hub.
 *
 * `chatgpt-siwc` is read by Signalbox's own CLIProxyAPI plugin
 * (native/cliproxyapi-chatgpt). Its field names are that plugin's contract:
 * change both together.
 *
 * @module accountHub/hubCredentials
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- file names hash synchronously.
import * as NodeCrypto from "node:crypto";

import type { ChatGptTransferredProfile } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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

/** A stable short id for a secret, safe to show and to use in file names. */
export const fingerprint = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 12);

/** `<type>-<email>.json`, so signing the same account in again replaces its file. */
const accountFileName = (type: string, email: string | undefined, fallback: string) =>
  `${type}-${(email && slug(email)) || fallback}.json`;

/** Cursor accounts: kept in the hub so they go with the pool, though the hub never routes them. */
export const CURSOR_CREDENTIAL_TYPE = "cursor";

export const CursorCredentialFile = Schema.Struct({
  type: Schema.Literal(CURSOR_CREDENTIAL_TYPE),
  api_key: Schema.String,
  created_at_ms: Schema.Number,
  email: Schema.optionalKey(Schema.String),
  backend_url: Schema.optionalKey(Schema.String),
  api_key_expires_at_ms: Schema.optionalKey(Schema.Number),
});

export function cursorCredentialFile(credential: {
  readonly apiKey: string;
  readonly email?: string | undefined;
  readonly backendUrl?: string | undefined;
  readonly apiKeyExpiresAtMs?: number | undefined;
  readonly createdAtMs: number;
}) {
  const content: typeof CursorCredentialFile.Type = {
    type: CURSOR_CREDENTIAL_TYPE,
    api_key: credential.apiKey,
    created_at_ms: credential.createdAtMs,
    ...(credential.email ? { email: credential.email } : {}),
    ...(credential.backendUrl ? { backend_url: credential.backendUrl } : {}),
    ...(credential.apiKeyExpiresAtMs === undefined
      ? {}
      : { api_key_expires_at_ms: credential.apiKeyExpiresAtMs }),
  };
  return {
    name: accountFileName(CURSOR_CREDENTIAL_TYPE, credential.email, fingerprint(credential.apiKey)),
    content,
  };
}

/**
 * Claude Code's own OAuth login as the hub's `claude` file. The hub refreshes
 * it with Claude Code's client, so the login keeps working once moved.
 */
export function claudeCredentialFile(login: {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string | undefined;
  readonly lastRefresh: string;
  readonly email: string | undefined;
  readonly accountUuid: string | undefined;
  readonly organizationUuid: string | undefined;
  readonly organizationName: string | undefined;
}) {
  return {
    name: accountFileName("claude", login.email, fingerprint(login.refreshToken)),
    content: {
      type: "claude",
      access_token: login.accessToken,
      refresh_token: login.refreshToken,
      last_refresh: login.lastRefresh,
      ...(login.expiresAt ? { expired: login.expiresAt } : {}),
      ...(login.email ? { email: login.email } : {}),
      ...(login.accountUuid ? { account_uuid: login.accountUuid } : {}),
      ...(login.organizationUuid ? { organization_uuid: login.organizationUuid } : {}),
      ...(login.organizationName ? { organization_name: login.organizationName } : {}),
    },
  };
}

/** The Codex CLI's own login as the hub's `codex` file; the hub uses the same OAuth client. */
export function codexCredentialFile(login: {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string | undefined;
  readonly lastRefresh: string | undefined;
  readonly email: string | undefined;
  readonly expiresAt: string | undefined;
}) {
  return {
    name: accountFileName(
      "codex",
      login.email,
      (login.accountId && slug(login.accountId)) || fingerprint(login.refreshToken),
    ),
    content: {
      type: "codex",
      id_token: login.idToken,
      access_token: login.accessToken,
      refresh_token: login.refreshToken,
      ...(login.accountId ? { account_id: login.accountId } : {}),
      ...(login.lastRefresh ? { last_refresh: login.lastRefresh } : {}),
      ...(login.email ? { email: login.email } : {}),
      ...(login.expiresAt ? { expired: login.expiresAt } : {}),
    },
  };
}
