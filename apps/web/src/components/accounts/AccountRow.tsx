import { Link, useNavigate } from "@tanstack/react-router";
import {
  EllipsisIcon,
  ShieldCheckIcon,
  LogInIcon,
  PauseIcon,
  PinIcon,
  PlayIcon,
  RouteIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { serverAnchor } from "../devices/devicesModel";
import { fleetServer } from "../devices/fleet";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { LimitWindows, ResetCreditDialog, resetCreditsSummary } from "../usage/UsageLimits";
import { notifyAccountsComingSoon, type AccountGroup, type PoolAccount } from "./accountPoolsModel";
import { POOL_DRIVER } from "./accountPoolsPrimitives";

const serverName = (id: string) => fleetServer(id)?.name ?? id;

/**
 * One pooled account: who it is, the groups that may use it, the weekly
 * window, and banked resets. Status badges only appear when something is off.
 */
export function AccountRow({
  account,
  groups,
  now,
}: {
  readonly account: PoolAccount;
  /** Resolved from the Plugins groups, in the account's order. */
  readonly groups: readonly AccountGroup[];
  readonly now: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const banked = account.resetCredits.availableCount;
  const via = account.pin.reroutedViaServerId;
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 md:grid md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_11rem_auto] md:items-center md:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm text-foreground">{account.name}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {account.plan}
          {groups.map((group) => (
            <Badge
              key={group.id}
              variant="outline"
              size="sm"
              render={<Link to="/plugins" search={{ section: "groups", group: group.id }} />}
            >
              {group.label}
            </Badge>
          ))}
          {account.state === "paused" ? (
            <Badge variant="secondary" size="sm">
              Paused
            </Badge>
          ) : null}
          {account.state === "needsLogin" ? (
            <Badge variant="warning" size="sm">
              Sign-in expired
            </Badge>
          ) : null}
        </span>
        {via !== undefined ? (
          <Link
            to="/devices"
            hash={serverAnchor(account.pin.serverId)}
            className="flex w-fit items-center gap-1 text-xs text-warning-foreground hover:underline"
          >
            <RouteIcon className="size-3 shrink-0" aria-hidden />
            Rerouted via {serverName(via)} while {serverName(account.pin.serverId)} updates
          </Link>
        ) : null}
      </div>

      <LimitWindows
        driver={POOL_DRIVER[account.harness]}
        windows={account.windows}
        now={now}
        compact
      />

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate tabular-nums">
          {banked === 0 ? "No resets banked" : resetCreditsSummary(account.resetCredits, now, true)}
        </span>
        {banked > 0 ? (
          <Button size="xs" variant="outline" onClick={() => setConfirming(true)}>
            Use
          </Button>
        ) : null}
      </div>

      <AccountActions account={account} groups={groups} />
      <ResetCreditDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => {
          setConfirming(false);
          notifyAccountsComingSoon("Using a banked reset");
        }}
      />
    </li>
  );
}

function AccountActions({
  account,
  groups,
}: {
  readonly account: PoolAccount;
  readonly groups: readonly AccountGroup[];
}) {
  const navigate = useNavigate();
  // Locked only when every group it serves is admin-managed; your own group keeps it yours.
  const locked = groups.length > 0 && groups.every((group) => group.adminManaged);
  const manager = groups.find((group) => group.adminManaged);
  const paused = account.state === "paused";
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost-muted" size="icon-xs" />}
        aria-label={`Actions for ${account.name}`}
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        {locked ? (
          <p className="flex max-w-60 items-start gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <ShieldCheckIcon className="mt-px size-3.5 shrink-0" aria-hidden />
            Managed by {manager?.adminLabel ?? "group admins"}.
          </p>
        ) : null}
        <MenuItem
          onClick={() =>
            void navigate({ to: "/devices", hash: serverAnchor(account.pin.serverId) })
          }
        >
          <PinIcon aria-hidden />
          Exits via {serverName(account.pin.serverId)}
        </MenuItem>
        <MenuItem disabled={locked} onClick={() => notifyAccountsComingSoon("Re-login")}>
          <LogInIcon aria-hidden />
          Re-login
        </MenuItem>
        <MenuItem
          disabled={locked}
          onClick={() => notifyAccountsComingSoon(paused ? "Resume" : "Pause")}
        >
          {paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
          {paused ? "Resume" : "Pause"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          disabled={locked}
          onClick={() => notifyAccountsComingSoon("Remove account")}
        >
          <Trash2Icon aria-hidden />
          Remove
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
