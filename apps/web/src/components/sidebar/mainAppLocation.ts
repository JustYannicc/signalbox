import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

// Settings, Usage, and Pull Requests replace the sidebar utility row with a
// Back button. Everything else is the main app. Legacy `/projects/<key>` links
// redirect into settings, so they count too and are never remembered.
export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/accounts" ||
    pathname === "/pull-requests" ||
    // Fork: rail view pages. Leaving them returns to the last thread, not to them.
    pathname === "/spaces" ||
    pathname === "/plugins" ||
    pathname === "/automations" ||
    pathname.startsWith("/automations/") ||
    ["/devices", "/team", "/computers", "/setup", "/capture"].some(
      (page) => pathname === page || pathname.startsWith(`${page}/`),
    )
  );
}

let mainAppHref: string | null = null;

// Mount once in the app shell. Records the latest main app URL so Back can
// return there no matter how many utility pages were visited since.
export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  useEffect(() => {
    if (href !== null) mainAppHref = href;
  }, [href]);
  return null;
}

// Leaves a utility page for the last main app URL, or the assistant when the
// app was opened directly on a utility page.
export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ href: mainAppHref ?? "/assistant" }), [navigate]);
}
