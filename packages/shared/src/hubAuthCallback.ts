// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native loopback helper uses a bounded Node listener with AbortController cleanup.
/**
 * One-click sign-in for logins the account hub (CLIProxyAPI) runs. Codex,
 * Claude, and Antigravity redirect to fixed localhost ports that only reach a
 * hub on the same machine. The desktop app listens there instead, catches the
 * redirect, and hands the address back so the hub finishes the login: no
 * pasting, wherever the hub runs. Codes and PKCE stay with the hub.
 *
 * @module hubAuthCallback
 */
import * as NodeHttp from "node:http";

/** The hub's own logins: their public clients and fixed redirects (CLIProxyAPI's constants). */
const LOGINS = [
  {
    authorize: "https://auth.openai.com/oauth/authorize",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirectUri: "http://localhost:1455/auth/callback",
  },
  {
    authorize: "https://claude.ai/oauth/authorize",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirectUri: "http://localhost:54545/callback",
  },
  {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    redirectUri: "http://localhost:51121/oauth-callback",
  },
] as const;

// The hub forgets a login after five minutes.
const LISTEN_FOR_MS = 300_000;

/** The redirect and state of a hub login, or undefined for anything else. */
export function hubAuthorizationRequest(value: string) {
  try {
    if (value.length > 16_384) return undefined;
    const url = new URL(value);
    const login = LOGINS.find((entry) => `${url.origin}${url.pathname}` === entry.authorize);
    const single = (key: string) => {
      const values = url.searchParams.getAll(key);
      return values.length === 1 && values[0] ? values[0] : undefined;
    };
    const state = single("state");
    if (
      !login ||
      url.username ||
      url.password ||
      url.hash ||
      single("client_id") !== login.clientId ||
      single("redirect_uri") !== login.redirectUri ||
      single("response_type") !== "code" ||
      !state ||
      !/^[\w.~-]{8,256}$/u.test(state)
    ) {
      return undefined;
    }
    return { authorizationUrl: url.toString(), redirectUri: login.redirectUri, state };
  } catch {
    return undefined;
  }
}

/** The redirect for this login: its path, its state, and either a code or an error. */
function hubCallbackUrl(value: string, redirectUri: string, state: string) {
  const callback = new URL(value);
  const expected = new URL(redirectUri);
  const states = callback.searchParams.getAll("state");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  if (
    value.length > 16_384 ||
    callback.pathname !== expected.pathname ||
    states.length !== 1 ||
    states[0] !== state ||
    !(
      (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
      (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
    )
  ) {
    throw new Error("This response does not belong to the active sign-in.");
  }
  // The hub reads only state, code, and error, from the address the provider used.
  return `${redirectUri}${callback.search}`;
}

/** One sign-in per port; a new one replaces whatever is still listening there. */
const listeners = new Map<
  number,
  { state: string; abort: AbortController; closed: Promise<void> }
>();

export function cancelHubAuthCallback(authorizationUrl: string) {
  const request = hubAuthorizationRequest(authorizationUrl);
  if (!request) return;
  const current = listeners.get(Number(new URL(request.redirectUri).port));
  if (current?.state === request.state) current.abort.abort();
}

const DONE_PAGE =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Signalbox</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>Return to Signalbox</h1><p>Signed in. Signalbox is adding the account; you can close this tab.</p></main></body></html>';

const listen = (server: NodeHttp.Server, port: number, host: string) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

/** Opens the sign-in page and resolves with the redirect address once the provider sends it. */
export async function receiveHubAuthCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
) {
  const request = hubAuthorizationRequest(authorizationUrl);
  if (!request) throw new Error("Invalid sign-in request.");
  const port = Number(new URL(request.redirectUri).port);
  const previous = listeners.get(port);
  if (previous) {
    previous.abort.abort();
    await previous.closed;
  }
  const abort = new AbortController();
  const closing = Promise.withResolvers<void>();
  listeners.set(port, { state: request.state, abort, closed: closing.promise });
  const callback = Promise.withResolvers<string>();
  void callback.promise.catch(() => undefined);
  const handle: NodeHttp.RequestListener = (incoming, response) => {
    try {
      if (incoming.method !== "GET") throw new Error("method");
      const url = hubCallbackUrl(
        new URL(incoming.url ?? "/", request.redirectUri).toString(),
        request.redirectUri,
        request.state,
      );
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      );
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE);
      callback.resolve(url);
    } catch {
      response.writeHead(400).end("This response does not belong to the active sign-in.");
    }
  };
  // `localhost` can resolve to either address, so both are covered when the machine has IPv6.
  const servers = [NodeHttp.createServer(handle), NodeHttp.createServer(handle)];
  const cancelled = () => callback.reject(new Error("Sign-in cancelled."));
  abort.signal.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(
    () => callback.reject(new Error("Sign-in expired. Try again.")),
    LISTEN_FOR_MS,
  );
  timer.unref();
  try {
    await listen(servers[0]!, port, "127.0.0.1").catch(() => {
      throw new Error("The sign-in port is in use on this computer. Close the other sign-in.");
    });
    await listen(servers[1]!, port, "::1").catch(() => undefined);
    if (abort.signal.aborted) throw new Error("Sign-in cancelled.");
    if (!(await openBrowser(request.authorizationUrl))) {
      throw new Error("Could not open your browser.");
    }
    return await callback.promise;
  } finally {
    clearTimeout(timer);
    abort.signal.removeEventListener("abort", cancelled);
    if (listeners.get(port)?.abort === abort) listeners.delete(port);
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            if (server.listening) server.close(() => resolve());
            else resolve();
          }),
      ),
    );
    closing.resolve();
  }
}
