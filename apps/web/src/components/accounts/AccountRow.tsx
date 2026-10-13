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
import { useLevelLabel } from "../levels/LevelOptionsProvider";
import { LEVEL_POLICIES } from "../plugins/levelPolicyFixtures";
import { modelAccountManager } from "../plugins/levelPolicyModel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { LimitWindows, ResetCreditDialog, resetCreditsSummary } from "../usage/UsageLimits";
import { notifyAccountsComingSoon, type PoolAccount } from "./accountPoolsModel";
import { POOL_DRIVER } from "./accountPoolsPrimitives";

const serverName = (id: string) => fleetServer(id)?.name ?? id;

/**
 * One pooled account: who it is, the levels it sits at (it reaches every
 * folder inside them), the weekly window, and banked resets. Status badges
 * only appear when something is off.
 */
export function AccountRow({
  account,
  now,
}: {
  readonly account: PoolAccount;
  readonly now: number;
}) {
  const label = useLevelLabel();
  const [confirming, setConfirming] = useState(false);
  const banked = account.resetCredits.availableCount;
  const via = account.pin.reroutedViaServerId;
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 md:grid md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_11rem_auto] md:items-center md:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm text-foreground">{account.name}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {account.plan}
          {account.levels.map((level) => (
            <Badge
              key={level}
              variant="outline"
              size="sm"
              render={<Link to="/plugins" search={{ section: "levels", group: level }} />}
            >
              {label(level)}
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

      <AccountActions account={account} />
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

function AccountActions({ account }: { readonly account: PoolAccount }) {
  const navigate = useNavigate();
  const manager = modelAccountManager(account.levels, LEVEL_POLICIES);
  const locked = manager !== null;
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
            Managed by {manager}.
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
