/**
 * Account sub-rows under an integration. Each account's label is the name
 * models see ("Gmail · Work account"), so it is editable in place.
 */
import { PencilIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { GroupBadges } from "./groupPrimitives";
import { connectionDisplayName, type ConnectionAccount, type Integration } from "./pluginsModel";
import { AuthStateBadge, comingSoon, StatusDot } from "./pluginsPrimitives";

/** Click to rename; Enter or blur saves, Escape cancels. Empty names fall back to the old one. */
export function AccountNameEditor(props: {
  integration: Integration;
  name: string;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const next = draft?.trim();
    if (next && next !== props.name) props.onRename(next);
    setDraft(null);
  };

  if (draft !== null) {
    return (
      <Input
        size="compact"
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(null);
        }}
        aria-label={`Name models see for this ${props.integration.name} account`}
        className="max-w-56"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setDraft(props.name)}
      className="group/name -mx-1 flex min-w-0 items-center gap-1.5 rounded-sm px-1 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Rename ${connectionDisplayName(props.integration, props.name)}`}
    >
      <span className="truncate">{props.name}</span>
      <PencilIcon
        aria-hidden
        className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover/name:opacity-100 group-focus-visible/name:opacity-100"
      />
    </button>
  );
}

export function AccountRow(props: {
  integration: Integration;
  account: ConnectionAccount;
  name: string;
  onRename: (name: string) => void;
}) {
  const { account, integration } = props;
  const broken = account.auth === "needs-reauth" || account.auth === "error";
  return (
    <div className="flex items-center gap-3 py-1.5 pr-3 pl-20 sm:pr-4">
      <StatusDot auth={account.auth} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <AccountNameEditor
            integration={integration}
            name={props.name}
            onRename={props.onRename}
          />
        </div>
        <span className="truncate text-xs text-muted-foreground">
          {account.identity} · models see “{connectionDisplayName(integration, props.name)}”
        </span>
      </div>
      <GroupBadges groups={account.groups} />
      {broken ? (
        <>
          <AuthStateBadge auth={account.auth} />
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              comingSoon(`Reconnect ${connectionDisplayName(integration, props.name)}`)
            }
          >
            Reconnect
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** Names start from fixtures and live only on this page until there is a backend. */
export function useAccountNames(integrations: readonly Integration[]) {
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      integrations.flatMap((integration) =>
        integration.accounts.map((account) => [account.id, account.label]),
      ),
    ),
  );
  const rename = (accountId: string, name: string) =>
    setNames((current) => ({ ...current, [accountId]: name }));
  return [names, rename] as const;
}
