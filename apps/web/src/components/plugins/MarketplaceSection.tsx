/**
 * Marketplace: browse and share workflows and skills. Skills come from and
 * install through skills.sh; workflows are automation templates you copy.
 */
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, ExternalLinkIcon, PlusIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { cn } from "~/lib/utils";
import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  MARKETPLACE,
  type MarketplaceTab,
  type SkillListing,
  type WorkflowListing,
} from "./marketplaceFixtures";
import { orgGroup } from "./groupPrimitives";
import { comingSoon, DEEP_LINK_ROW_CLASS, useDeepLinkRow } from "./pluginsPrimitives";

const TEAM_NAME = orgGroup()?.name ?? "Your team";

const TABS: readonly { value: MarketplaceTab; label: string }[] = [
  { value: "discover", label: "Discover" },
  { value: "team", label: TEAM_NAME },
  { value: "yours", label: "Published by you" },
];

const EMPTY_COPY: Record<MarketplaceTab, string> = {
  discover: "Nothing matches.",
  team: `Nobody in ${TEAM_NAME} has shared anything that matches.`,
  yours: "You have not published anything that matches.",
};

export type MarketplaceKindFilter = "all" | "workflows" | "skills";

const KIND_FILTERS: readonly { value: MarketplaceKindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "workflows", label: "Workflows" },
  { value: "skills", label: "Skills" },
];

const compact = new Intl.NumberFormat("en", { notation: "compact" });

function WorkflowRow(props: { workflow: WorkflowListing; targeted: boolean }) {
  const { workflow } = props;
  const rowRef = useDeepLinkRow<HTMLDivElement>(props.targeted);
  return (
    <div
      ref={rowRef}
      className={cn(
        "flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-4",
        props.targeted && DEEP_LINK_ROW_CLASS,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{workflow.name}</span>
        <p className="text-xs text-muted-foreground">{workflow.description}</p>
        <ol className="flex flex-wrap items-center gap-1 text-xs text-foreground">
          {workflow.steps.map((step, index) => (
            <li key={step} className="flex items-center gap-1">
              {index > 0 ? (
                <ArrowRightIcon aria-hidden className="size-3 text-muted-foreground" />
              ) : null}
              <span className="rounded-sm bg-muted px-1.5 py-0.5">{step}</span>
            </li>
          ))}
        </ol>
        <span className="text-xs text-muted-foreground tabular-nums">
          {workflow.author} · used {compact.format(workflow.uses)} times
        </span>
      </div>
      {/* The assistant sets it up with your accounts; it lands in Automations when done. */}
      <Button
        size="sm"
        variant="outline"
        render={
          <Link to="/assistant" search={{ prompt: `Set up the ${workflow.name} workflow` }} />
        }
      >
        Use workflow
      </Button>
    </div>
  );
}

function SkillListingRow(props: { skill: SkillListing }) {
  const { skill } = props;
  return (
    <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm text-foreground">{skill.name}</span>
          <Badge variant="outline" size="sm">
            skills.sh
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{skill.description}</p>
        <span className="text-xs text-muted-foreground tabular-nums">
          {skill.author} · <span className="font-mono">{skill.registry}</span> ·{" "}
          {compact.format(skill.installs)} installs
        </span>
      </div>
      {skill.installedSkillId ? (
        <Button
          size="sm"
          variant="ghost"
          render={
            <Link to="/plugins" search={{ section: "skills", skill: skill.installedSkillId }} />
          }
        >
          Installed
        </Button>
      ) : (
        <Button size="sm" onClick={() => comingSoon(`npx skills add ${skill.registry}`)}>
          Install
        </Button>
      )}
    </div>
  );
}

export function MarketplaceSection(props: {
  kind?: MarketplaceKindFilter | undefined;
  item?: string | undefined;
}) {
  const initialTab = MARKETPLACE.find((listing) => listing.id === props.item)?.tabs[0];
  const [tab, setTab] = useState<MarketplaceTab>(initialTab ?? "discover");
  const [kind, setKind] = useState<MarketplaceKindFilter>(props.kind ?? "all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const listings = MARKETPLACE.filter(
    (listing) =>
      listing.tabs.includes(tab) &&
      (deferredQuery.length === 0 ||
        listing.name.toLowerCase().includes(deferredQuery) ||
        listing.description.toLowerCase().includes(deferredQuery)),
  );
  const workflows =
    kind === "skills" ? [] : listings.filter((listing) => listing.kind === "workflow");
  const skills = kind === "workflows" ? [] : listings.filter((listing) => listing.kind === "skill");

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 px-3 sm:px-4">
        <p className="text-sm text-muted-foreground">
          Workflows and skills to reuse. Skills install through skills.sh.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label="Marketplace view"
            value={[tab]}
            onValueChange={(next) => {
              const value = TABS.find((entry) => entry.value === next[0]);
              if (value) setTab(value.value);
            }}
          >
            {TABS.map((entry) => (
              <Toggle key={entry.value} value={entry.value}>
                {entry.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <ToggleGroup
            aria-label="Kind"
            value={[kind]}
            onValueChange={(next) => {
              const value = KIND_FILTERS.find((entry) => entry.value === next[0]);
              if (value) setKind(value.value);
            }}
          >
            {KIND_FILTERS.map((entry) => (
              <Toggle key={entry.value} value={entry.value}>
                {entry.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <Input
            type="search"
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search workflows and skills"
            aria-label="Search the marketplace"
            className="sm:ms-auto sm:max-w-64"
          />
        </div>
      </div>

      {workflows.length + skills.length === 0 ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">{EMPTY_COPY[tab]}</p>
      ) : null}
      {workflows.length > 0 ? (
        <SettingsSection
          title="Workflows"
          headerAction={
            tab === "yours" ? (
              <Button size="xs" variant="outline" onClick={() => comingSoon("Publish a workflow")}>
                <PlusIcon aria-hidden />
                Publish a workflow
              </Button>
            ) : undefined
          }
        >
          {workflows.map((workflow) => (
            <WorkflowRow
              key={workflow.id}
              workflow={workflow}
              targeted={props.item === workflow.id}
            />
          ))}
        </SettingsSection>
      ) : null}
      {skills.length > 0 ? (
        <SettingsSection
          title="Skills"
          headerAction={
            <Button
              size="xs"
              variant="ghost"
              render={<a href="https://skills.sh" target="_blank" rel="noreferrer" />}
            >
              skills.sh
              <ExternalLinkIcon aria-hidden />
            </Button>
          }
        >
          {skills.map((skill) => (
            <SkillListingRow key={skill.id} skill={skill} />
          ))}
        </SettingsSection>
      ) : null}
    </div>
  );
}
