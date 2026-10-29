import * as Schema from "effect/Schema";
import { createDeploy3CloudflareApi, safeCloudflareId } from "./cloudflareTransport.ts";
import type { TokenExpiryStatus } from "./teardownReceipt.ts";

const TokenRecord = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["active", "disabled", "expired"]),
  expires_on: Schema.String,
});

const decodeTokenRecord = Schema.decodeUnknownSync(TokenRecord);

/** AccountApiToken uses /accounts/{account_id}/tokens/verify. A denial alone never proves expiry. */
export async function verifyDeploy3TokenExpiry(input: {
  readonly accountId: string;
  readonly authorityToken: string;
  readonly tokenId: string;
  readonly expectedExpiresOn: string;
  readonly nowMs: number;
  readonly mode: "self" | "account-record";
  readonly fetchImpl?: typeof fetch;
}): Promise<{ status: TokenExpiryStatus; expiresOn: string | null }> {
  if (
    !/^[a-f0-9]{32}$/.test(input.accountId) ||
    !safeCloudflareId(input.tokenId) ||
    !input.authorityToken ||
    !Number.isSafeInteger(input.nowMs)
  ) {
    return { status: "unverified", expiresOn: null };
  }
  const expectedMs = Date.parse(input.expectedExpiresOn);
  if (!Number.isSafeInteger(expectedMs)) return { status: "unverified", expiresOn: null };
  const api = createDeploy3CloudflareApi({
    accountId: input.accountId,
    token: input.authorityToken,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  try {
    const observed = await api.request(
      "verify-token-expiry",
      "GET",
      input.mode === "self" ? "/tokens/verify" : `/tokens/${encodeURIComponent(input.tokenId)}`,
    );
    const record = decodeTokenRecord(observed.result);
    if (record.id !== input.tokenId || Date.parse(record.expires_on) !== expectedMs) {
      return { status: "unverified", expiresOn: null };
    }
    if (record.status === "expired" && input.nowMs >= expectedMs) {
      return { status: "expired-verified", expiresOn: record.expires_on };
    }
    if (record.status === "active" && input.nowMs < expectedMs) {
      return { status: "expiry-configured", expiresOn: record.expires_on };
    }
    return { status: "unverified", expiresOn: record.expires_on };
  } catch {
    return { status: "unverified", expiresOn: null };
  }
}
