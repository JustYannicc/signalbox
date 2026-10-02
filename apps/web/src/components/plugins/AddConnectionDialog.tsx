/**
 * Add connection: one-click managed OAuth for the common providers, or bring
 * your own API, GraphQL, or MCP source. Every path lands in Executor under
 * the chosen group and a name models will see.
 */
import { BracesIcon, ChevronRightIcon, NetworkIcon, ServerIcon, TerminalIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactElement, type ReactNode } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { GROUPS } from "./groupsFixtures";
import { groupNames } from "./groupPrimitives";
import { useAddedConnections, type NewConnectionInput } from "./addedConnectionsStore";
import type { IntegrationKind } from "./pluginsModel";
import { IntegrationMark } from "./pluginsPrimitives";

const MANAGED_OAUTH: readonly { name: string; glyph: string; covers: string }[] = [
  { name: "Google", glyph: "G", covers: "Gmail, Drive, Calendar, Docs, Sheets" },
  { name: "GitHub", glyph: "Gh", covers: "Repositories, issues, Actions" },
  { name: "Microsoft 365", glyph: "Ms", covers: "Outlook, OneDrive, Teams" },
  { name: "Atlassian", glyph: "At", covers: "Jira, Confluence" },
  { name: "Slack", glyph: "Sl", covers: "Messages, channels, search" },
  { name: "Notion", glyph: "N", covers: "Pages and databases" },
];

const BRING_YOUR_OWN: readonly {
  label: string;
  detail: string;
  icon: typeof BracesIcon;
  kind: IntegrationKind;
  via: "executor" | "direct";
}[] = [
  {
    kind: "openapi",
    via: "executor",
    label: "OpenAPI spec",
    detail: "Point at a spec URL; Executor makes each operation a tool",
    icon: BracesIcon,
  },
  {
    kind: "graphql",
    via: "executor",
    label: "GraphQL endpoint",
    detail: "Introspects the schema into queries and mutations",
    icon: NetworkIcon,
  },
  {
    kind: "mcp",
    via: "executor",
    label: "Remote MCP server",
    detail: "HTTP MCP brokered by Executor, one sign-in for all harnesses",
    icon: ServerIcon,
  },
  {
    kind: "mcp",
    via: "direct",
    label: "Local MCP server",
    detail: "Runs from each harness's config, outside Executor",
    icon: TerminalIcon,
  },
];

function OptionRow(props: {
  lead: ReactNode;
  title: string;
  detail: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
    >
      {props.lead}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{props.title}</span>
        <span className="truncate text-xs text-muted-foreground">{props.detail}</span>
      </span>
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function AddConnectionDialog(props: { trigger: ReactElement; children: ReactNode }) {
  const [groupIds, setGroupIds] = useState<readonly string[]>(() =>
    GROUPS.filter((group) => group.org === undefined).map((group) => group.id),
  );
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const addConnection = useAddedConnections((state) => state.add);
  const navigate = useNavigate();
  // Ends on the new row in Connections, highlighted, so the add is visible where it lives.
  const connect = (input: Omit<NewConnectionInput, "accountLabel" | "groups">) => {
    const added = addConnection({ ...input, accountLabel: name, groups: groupIds });
    toastManager.add({
      title: "Connected (preview)",
      description: `${added.name}${groupIds.length > 0 ? ` in ${groupNames(groupIds)}` : ""}`,
      timeout: 3000,
    });
    setOpen(false);
    setName("");
    void navigate({ to: "/plugins", search: { section: "connections", item: added.id } });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={props.trigger}>{props.children}</DialogTrigger>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add connection</DialogTitle>
          <DialogDescription>
            Agents see it in the groups you pick, under the name you give it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
            <span className="text-sm text-muted-foreground">Groups</span>
            <ToggleGroup
              aria-label="Groups for the new connection"
              multiple
              value={[...groupIds]}
              onValueChange={(next) => setGroupIds(next)}
            >
              {GROUPS.map((entry) => (
                <Toggle key={entry.id} value={entry.id}>
                  {entry.name}
                </Toggle>
              ))}
            </ToggleGroup>
            <label htmlFor="new-connection-name" className="text-sm text-muted-foreground">
              Name models see
            </label>
            <Input
              id="new-connection-name"
              size="sm"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Work account"
            />
          </div>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">One click · managed OAuth</h3>
            <div className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60">
              {MANAGED_OAUTH.map((provider) => (
                <OptionRow
                  key={provider.name}
                  lead={<IntegrationMark glyph={provider.glyph} />}
                  title={`Connect ${provider.name}`}
                  detail={provider.covers}
                  onSelect={() =>
                    connect({
                      name: provider.name,
                      glyph: provider.glyph,
                      kind: "openapi",
                      via: "executor",
                    })
                  }
                />
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Bring your own</h3>
            <div className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60">
              {BRING_YOUR_OWN.map((option) => (
                <OptionRow
                  key={option.label}
                  lead={
                    <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
                      <option.icon aria-hidden className="size-4" />
                    </span>
                  }
                  title={option.label}
                  detail={option.detail}
                  onSelect={() =>
                    connect({
                      name: option.label,
                      glyph: option.label.slice(0, 2),
                      kind: option.kind,
                      via: option.via,
                    })
                  }
                />
              ))}
            </div>
          </section>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
