import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { SignInScreen, type SignInSearch } from "../account/SignInScreen";

const SEARCH_KEYS = ["returnTo", "error", "handoff"] as const;

function validateSignInSearch(search: Record<string, unknown>): SignInSearch {
  const result: { -readonly [K in keyof SignInSearch]?: SignInSearch[K] } = {};
  for (const key of SEARCH_KEYS) {
    const value = search[key];
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  // `?selectAccount=1` parses as a number.
  if (String(search.selectAccount) === "1") result.selectAccount = "1";
  return result;
}

/** Root `beforeLoad` owns who may be here; see `account/accountGate.ts`. */
export const Route = createFileRoute("/sign-in")({
  validateSearch: validateSignInSearch,
  component: SignInRouteView,
});

function SignInRouteView() {
  const search = Route.useSearch();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const navigate = useNavigate();
  const onConsumed = useCallback(() => {
    void navigate({
      to: "/sign-in",
      search: (previous) => ({
        ...(previous.returnTo ? { returnTo: previous.returnTo } : {}),
        ...(previous.selectAccount ? { selectAccount: previous.selectAccount } : {}),
      }),
      replace: true,
    });
  }, [navigate]);

  return <SignInScreen search={search} searchStr={searchStr} onConsumed={onConsumed} />;
}
