/**
 * The inline panel under an integration row: its tools, scopes, where it is
 * routed, and the account actions. Actions only toast in the prototype.
 */
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { AccountNameEditor } from "./ConnectionAccounts";
import { GroupBadges, groupById, ManagedNote } from "./groupPrimitives";
import { isRestricted } from "./groupsModel";
import {
  connectionDisplayName,
  KIND_LABEL,
  type ConnectionAccount,
  type HarnessId,
  type Integration,
} from "./pluginsModel";
import { comingSoon, HarnessToggles } from "./pluginsPrimitives";

const VISIBLE_TOOL_COUNT = 6;

export function IntegrationDetail(props: {
  integration: Integration;
  /** The only account, when there is exactly one; several are listed as rows above. */
  single: ConnectionAccount | undefined;
  singleName: string | undefined;
  onRename: (name: string) => void;
  enabled: readonly HarnessId[];
  onToggleHarness: (harness: HarnessId) => void;
}) {
  const { integration } = props;
  const hiddenTools =
    integration.toolCount - Math.min(integration.tools.length, VISIBLE_TOOL_COUNT);
  // Company-provided connections in a restricted group: only its admins remove them.
  const adminGroup = integration.accounts.every((account) => account.addedBy === "admins")
    ? groupById(integration.accounts[0]?.groups[0] ?? "")
    : undefined;
  const managedBy = adminGroup && isRestricted(adminGroup, "connections") ? adminGroup : undefined;
  const route =
    integration.via === "executor"
      ? `${KIND_LABEL[integration.kind]} via Executor`
      : `${KIND_LABEL[integration.kind]} over ${integration.transport ?? "stdio"}, configured per harness`;

  return (
    <div className="flex flex-col gap-4 border-t border-border/50 bg-muted/24 px-4 py-4 sm:pl-14">
      {integration.authDetail ? (
        <p className="text-sm text-foreground">
          <span className="font-medium">
            {integration.auth === "needs-reauth" ? "Sign-in expired. " : "Can't reach it. "}
          </span>
          <span className="text-muted-foreground">{integration.authDetail}</span>
        </p>
      ) : null}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Route</dt>
        <dd className="text-foreground">{route}</dd>
        {props.single && props.singleName ? (
          <>
            <dt className="self-center text-muted-foreground">Account</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <AccountNameEditor
                integration={integration}
                name={props.singleName}
                onRename={props.onRename}
              />
              <span className="truncate text-xs text-muted-foreground">
                {props.single.identity} · models see “
                {connectionDisplayName(integration, props.singleName)}”
              </span>
            </dd>
            <dt className="self-center text-muted-foreground">Group</dt>
            <dd>
              <GroupBadges groups={props.single.groups} />
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Scopes</dt>
        <dd className="flex flex-wrap gap-1">
          {integration.scopes.length === 0 ? (
            <span className="text-muted-foreground">None, runs locally</span>
          ) : (
            integration.scopes.map((scope) => (
              <Badge key={scope} variant="outline" size="sm">
                {scope}
              </Badge>
            ))
          )}
        </dd>
        <dt className="self-center text-muted-foreground">Available to</dt>
        <dd>
          <HarnessToggles
            itemName={integration.name}
            enabled={props.enabled}
            onToggle={props.onToggleHarness}
            className="-ml-1"
          />
        </dd>
      </dl>

      <div className="flex flex-col gap-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">
          Tools <span className="tabular-nums">({integration.toolCount})</span>
        </h4>
        <ul className="flex flex-col divide-y divide-border/40 rounded-lg border border-border/50 bg-background">
          {integration.tools.slice(0, VISIBLE_TOOL_COUNT).map((tool) => (
            <li
              key={tool.name}
              className="flex min-w-0 flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-4"
            >
              <code className="shrink-0 font-mono text-xs text-foreground sm:w-56 sm:truncate">
                {tool.name}
              </code>
              <span className="min-w-0 text-xs text-muted-foreground">{tool.description}</span>
            </li>
          ))}
          {hiddenTools > 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {hiddenTools} more tools from {integration.name}
            </li>
          ) : null}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {integration.via === "executor" ? (
          <Button
            size="sm"
            variant={integration.auth === "connected" ? "outline" : "default"}
            onClick={() => comingSoon(`Reconnect ${integration.name}`)}
          >
            Reconnect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => comingSoon(`Move ${integration.name} into Executor`)}
          >
            Route through Executor
          </Button>
        )}
        {integration.via === "executor" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => comingSoon(`Add another ${integration.name} account`)}
          >
            Add account
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => comingSoon(`Test ${integration.name}`)}>
          Test connection
        </Button>
        {managedBy ? (
          <span className="ms-auto">
            <ManagedNote group={managedBy} />
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost-destructive"
            className="ms-auto"
            onClick={() => comingSoon(`Remove ${integration.name}`)}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
