import { useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";

const TABS = [
  { to: "/accounts", label: "Accounts", id: "accounts" },
  { to: "/usage", label: "Tokens", id: "tokens" },
] as const;

/**
 * Usage is one page with two views: pooled subscription accounts and token
 * spend. Rendered as the page title on both, so either view is one click away.
 * Navigates with `useNavigate` rather than `Link` so the usage page's tests,
 * which mock only the router hooks, keep rendering it.
 */
export function UsageTabs({ current }: { readonly current: (typeof TABS)[number]["id"] }) {
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-2">
      <h1 className="sr-only">Usage</h1>
      <nav aria-label="Usage views" className="flex items-center gap-0.5">
        {TABS.map((tab) => (
          <Button
            key={tab.id}
            size="xs"
            variant={tab.id === current ? "secondary" : "ghost-muted"}
            aria-current={tab.id === current ? "page" : undefined}
            onClick={() => {
              if (tab.id !== current) void navigate({ to: tab.to, replace: true });
            }}
          >
            {tab.label}
          </Button>
        ))}
      </nav>
    </div>
  );
}
