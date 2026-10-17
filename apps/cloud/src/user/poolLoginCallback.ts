import {
  CLAUDE_MANUAL_REDIRECT,
  type LoginCallback,
  type PoolLoginFlow,
} from "../pool/cliProxyApi.ts";

const single = (url: URL, key: string) => {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && values[0] ? values[0] : null;
};

const manualCode = (authorization: URL, state: string, input: string): LoginCallback | null => {
  if (
    authorization.protocol !== "https:" ||
    authorization.username ||
    authorization.password ||
    single(authorization, "state") !== state ||
    single(authorization, "redirect_uri") !== CLAUDE_MANUAL_REDIRECT
  ) {
    return null;
  }
  const [code, submittedState, ...extra] = input.trim().split("#");
  if (
    !code ||
    !/^[\w.~+/=-]+$/u.test(code) ||
    extra.length > 0 ||
    (submittedState !== undefined && submittedState !== state)
  ) {
    return null;
  }
  return { state, code };
};

/** Validates a pasted code against the active authorize URL, or preserves its loopback callback. */
export const poolLoginCallback = (
  authorizationUrl: string,
  state: string,
  input: string,
  flow: PoolLoginFlow = "browser",
): LoginCallback | null => {
  try {
    const authorization = new URL(authorizationUrl);
    if (single(authorization, "state") !== state) return null;
    if (flow === "manual") return manualCode(authorization, state, input);

    const redirect = new URL(single(authorization, "redirect_uri") ?? "");
    if (
      redirect.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash
    ) {
      return null;
    }

    const value = input.trim();
    if (/^https?:\/\//iu.test(value)) {
      const callback = new URL(value);
      const codes = callback.searchParams.getAll("code");
      const errors = callback.searchParams.getAll("error");
      const descriptions = callback.searchParams.getAll("error_description");
      const denial =
        descriptions.length <= 1 &&
        ((errors.length === 1 && errors[0]) ||
          (errors.length === 0 && descriptions.length === 1 && descriptions[0]));
      if (
        callback.origin !== redirect.origin ||
        callback.pathname !== redirect.pathname ||
        callback.username ||
        callback.password ||
        callback.hash ||
        single(callback, "state") !== state ||
        !(
          (codes.length === 1 && codes[0] && errors.length === 0 && descriptions.length === 0) ||
          (codes.length === 0 && denial)
        )
      ) {
        return null;
      }
      return callback.toString();
    }

    const [code, submittedState, ...extra] = value.split("#");
    if (
      !code ||
      !/^[\w.~+/=-]+$/u.test(code) ||
      extra.length > 0 ||
      (submittedState !== undefined && submittedState !== state)
    ) {
      return null;
    }
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);
    return redirect.toString();
  } catch {
    return null;
  }
};
