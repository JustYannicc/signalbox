/**
 * Google refuses to sign anyone in inside an app's own web view, so on a
 * phone Google's pages open in the system browser view instead
 * (SFSafariViewController, Chrome Custom Tabs), where 1Password's AutoFill
 * signs in with one tap per device (#586, accepted 2026-10-16). That view
 * hides its address, so these tabs follow the thread one way: the phone opens
 * what the thread has, and reports nothing back.
 */
export function opensInSystemBrowser(url: string | null): boolean {
  if (url === null) return false;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return false;
    return hostname === "google.com" || hostname.endsWith(".google.com");
  } catch {
    return false;
  }
}
