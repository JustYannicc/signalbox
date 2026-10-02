import { CloudIcon, CpuIcon, HouseIcon, ServerIcon, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";
import type { ReactNode } from "react";

import {
  plural,
  serverAnchor,
  type ExecutionServer,
  type ServerRuntime,
  type ServerState,
} from "./devicesModel";
import { accountsExitingVia, FLEET_ACCOUNTS } from "./fleet";

const RUNTIME_ICON: Record<ServerRuntime, LucideIcon> = {
  hetzner: ServerIcon,
  "cloudflare-do": CloudIcon,
  home: HouseIcon,
  celld: CpuIcon,
};

const STATE_PRESENTATION: Record<ServerState, { label: string; dot: string; text: string }> = {
  online: { label: "Online", dot: "bg-success", text: "text-muted-foreground" },
  draining: { label: "Draining", dot: "bg-warning", text: "text-warning-foreground" },
  updating: { label: "Updating", dot: "bg-warning", text: "text-warning-foreground" },
  queued: { label: "Update queued", dot: "bg-success", text: "text-muted-foreground" },
};

const ROW_GRID =
  "md:grid md:grid-cols-[minmax(0,1.5fr)_7.5rem_5.5rem_7rem_minmax(0,1.6fr)] md:items-center md:gap-4";

/** Execution servers: every chat starts on one of these, never on a client. */
export function ServersSection({
  servers,
  children,
}: {
  readonly servers: readonly ExecutionServer[];
  /** Rendered under the list, e.g. the rolling update summary. */
  readonly children?: ReactNode;
}) {
  const serversById = new Map(servers.map((server) => [server.id, server]));
  const draining = servers.find((server) => server.drain !== undefined);
  return (
    <section aria-labelledby="devices-servers" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="devices-servers" className="text-sm font-medium text-foreground">
          Servers
        </h2>
        <span className="text-xs text-muted-foreground">
          Accounts exit through the server they're pinned to
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div
          aria-hidden
          className={cn(
            "hidden border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground",
            ROW_GRID,
          )}
        >
          <span>Server</span>
          <span>Status</span>
          <span className="text-end">Chats</span>
          <span>Load</span>
          <span>Pinned accounts</span>
        </div>
        <ul className="divide-y divide-border">
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              drainTarget={
                server.drain ? serversById.get(server.drain.toServerId)?.name : undefined
              }
              drainingName={draining?.name}
            />
          ))}
        </ul>
      </div>
      {children}
    </section>
  );
}

function ServerRow({
  server,
  drainTarget,
  drainingName,
}: {
  readonly server: ExecutionServer;
  readonly drainTarget: string | undefined;
  readonly drainingName: string | undefined;
}) {
  const Icon = RUNTIME_ICON[server.runtime];
  const state = STATE_PRESENTATION[server.state];
  const exiting = accountsExitingVia(server.id);
  const reroutedAway = FLEET_ACCOUNTS.filter(
    (account) =>
      account.pin.serverId === server.id && account.pin.reroutedViaServerId !== undefined,
  );
  return (
    <li id={serverAnchor(server.id)} className="flex scroll-mt-4 flex-col gap-2 px-3 py-3">
      <div className={cn("flex flex-col gap-2", ROW_GRID)}>
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {server.where} · v{server.version}
            </span>
          </div>
        </div>
        <span className={cn("flex items-center gap-1.5 text-xs", state.text)}>
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", state.dot)} />
          {state.label}
        </span>
        <span className="text-xs text-foreground tabular-nums md:text-end">
          <span className="md:hidden">Chats: </span>
          {server.chats}
        </span>
        <LoadCell server={server} />
        {exiting.length > 0 ? (
          <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {exiting.map((account) => {
              const Mark = PROVIDER_PRESENTATION[account.harness].mark;
              return (
                <li key={account.id} className="flex min-w-0 items-center gap-1">
                  <Mark className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{account.name}</span>
                  {account.pin.reroutedViaServerId ? (
                    <span className="shrink-0 text-warning-foreground">(for now)</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <span className="text-xs text-muted-foreground">
            {!server.canPinAccounts
              ? "None · no fixed IP"
              : reroutedAway.length > 0
                ? `${plural(reroutedAway.length, "account")} rerouted during the update`
                : "None"}
          </span>
        )}
      </div>
      {server.drain ? (
        <p className="text-xs text-warning-foreground">
          Draining for update · {plural(server.drain.movingChats, "chat")} moving to{" "}
          {drainTarget ?? server.drain.toServerId} · back after
        </p>
      ) : null}
      {server.movedInChats ? (
        <p className="text-xs text-muted-foreground">
          {plural(server.movedInChats, "chat")} moved here while {drainingName ?? "another server"}{" "}
          updates
        </p>
      ) : null}
    </li>
  );
}

function LoadCell({ server }: { readonly server: ExecutionServer }) {
  if (server.load === undefined) {
    return (
      <span className="text-xs text-muted-foreground">
        {server.runtime === "cloudflare-do" ? "Scales per chat" : "—"}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <div
        role="img"
        aria-label={`${server.load}% load`}
        className="relative h-1.5 w-full max-w-24 rounded-full bg-muted md:max-w-none"
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            server.load >= 80 ? "bg-warning" : "bg-muted-foreground",
          )}
          style={{ width: `${server.load}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
        {server.load}%
      </span>
    </div>
  );
}
