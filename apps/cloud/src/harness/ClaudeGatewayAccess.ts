// The facet's model transport owns this origin; the CLI never contacts it over the network.
export const CLAUDE_MODEL_GATEWAY_BASE_URL = "https://model.invalid";

export interface ClaudeGatewayAccess {
  readonly baseUrl: string;
  /** An opaque credential issued by the gateway for this run, never a provider key. */
  readonly credentialRef: string;
}

/** The host supplies routing and scoped access before the unchanged CLI starts. */
export function claudeGatewayEnvironment(access: ClaudeGatewayAccess) {
  if (!access?.baseUrl?.trim()) throw new Error("Claude model gateway base URL is missing");
  const url = new URL(access.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Claude model gateway base URL is invalid");
  if (!access.credentialRef || /\s/u.test(access.credentialRef))
    throw new Error("Claude model gateway credential reference is missing or invalid");
  return {
    ANTHROPIC_BASE_URL: access.baseUrl.replace(/\/+$/u, ""),
    ANTHROPIC_AUTH_TOKEN: access.credentialRef,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };
}

export function claudeGatewayEnvironmentFrom(
  environment: Readonly<Record<string, string | undefined>>,
) {
  return claudeGatewayEnvironment({
    baseUrl: environment.ANTHROPIC_BASE_URL ?? "",
    credentialRef: environment.ANTHROPIC_AUTH_TOKEN ?? "",
  });
}

/** A persistent CLI reference resolves against the canonical grant on every model request. */
export function claudeGatewayTransport(
  access: ClaudeGatewayAccess,
  current: () => Promise<ClaudeGatewayAccess>,
  forward: (request: Request) => Promise<Response>,
) {
  const environment = claudeGatewayEnvironment(access);
  return async (request: Request) => {
    const url = new URL(request.url);
    const base = new URL(environment.ANTHROPIC_BASE_URL);
    const supplied =
      request.headers.get("authorization")?.replace(/^Bearer /iu, "") ??
      request.headers.get("x-api-key");
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(`${base.pathname.replace(/\/$/u, "")}/`) ||
      supplied !== access.credentialRef
    )
      throw new Error("The model request belongs to another Claude gateway grant");
    const resolved = claudeGatewayEnvironment(await current());
    if (resolved.ANTHROPIC_BASE_URL !== environment.ANTHROPIC_BASE_URL)
      throw new Error("The live Claude model gateway route changed");
    const headers = new Headers(request.headers);
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${resolved.ANTHROPIC_AUTH_TOKEN}`);
    return forward(new Request(request, { headers }));
  };
}
