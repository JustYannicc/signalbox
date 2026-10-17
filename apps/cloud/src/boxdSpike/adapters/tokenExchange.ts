// @effect-diagnostics globalFetch:off - Fetch adapter for the SDK token protocol, outside the Effect domain service.
import * as Schema from "effect/Schema";
import { TokenUnavailable } from "../TokenCache.ts";

const decode = Schema.decodeUnknownSync(
  Schema.Struct({ token: Schema.String, expires_at: Schema.Number }),
);

export async function exchangeToken(apiKey: string) {
  if (!apiKey) throw new TokenUnavailable();
  const response = await fetch("https://app.boxd.sh/api/v1/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new TokenUnavailable();
  }
  const session = decode(await response.json());
  return { token: session.token, expiresAt: session.expires_at * 1000 };
}
