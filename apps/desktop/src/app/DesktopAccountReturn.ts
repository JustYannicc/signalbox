/**
 * Signalbox account sign-in returns to the desktop as
 * `<scheme>://app/account-return?handoff=…` (or `?error=…`). The
 * renderer routes in the URL hash, so this maps the deep link to the in-app
 * sign-in route, keeping only the parameters that route reads. Anything else,
 * including the other build's scheme, is not ours.
 */
const ACCOUNT_RETURN_PATH = "/account-return";
const FORWARDED_PARAMS = ["handoff", "error"] as const;

export function accountReturnLoadUrl(
  value: string | undefined,
  isDevelopment: boolean,
): string | undefined {
  if (!value || value.length > 4_096) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const scheme = isDevelopment ? "signalbox-dev:" : "signalbox:";
  if (
    url.protocol !== scheme ||
    url.host !== "app" ||
    url.pathname !== ACCOUNT_RETURN_PATH ||
    url.username ||
    url.password
  ) {
    return undefined;
  }

  const search = new URLSearchParams();
  for (const key of FORWARDED_PARAMS) {
    const values = url.searchParams.getAll(key);
    if (values.length > 1) return undefined;
    if (values[0]) search.set(key, values[0]);
  }
  if (!search.has("handoff") && !search.has("error")) return undefined;
  return `${url.protocol}//app/#/sign-in?${search.toString()}`;
}
