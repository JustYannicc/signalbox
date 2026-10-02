/**
 * Pieces of a shared skill's page: its sync state for you, version history,
 * who it is synced to, and the repo details kept behind "Advanced".
 */
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { publicationFor } from "./skillSharingFixtures";
import {
  isOwnedByYou,
  latestVersion,
  skillSync,
  subscribersBehind,
  type SkillPublication,
} from "./skillSharingModel";

/** Compact state for a skill row; links to the skill's page. */
export function SkillShareBadge(props: { skillId: string }) {
  const publication = publicationFor(props.skillId);
  if (!publication) return null;
  const sync = skillSync(publication);
  const label = isOwnedByYou(publication)
    ? `Published v${latestVersion(publication)} · ${publication.subscribers.length} synced`
    : sync.state === "update-available"
      ? `Update available · v${sync.latest}`
      : sync.state === "auto-updated"
        ? `v${publication.yourVersion} · auto-updated ${sync.when}`
        : `v${publication.yourVersion}`;
  return (
    <Badge
      size="sm"
      variant={sync.state === "update-available" ? "warning" : "success"}
      render={<Link to="/plugins" search={{ section: "skills", skill: props.skillId }} />}
    >
      {label}
    </Badge>
  );
}

/** Your copy of someone else's skill: what the last publish did, and whether to follow. */
export function SyncStatus(props: { publication: SkillPublication }) {
  const { publication } = props;
  const [autoUpdate, setAutoUpdate] = useState(publication.autoUpdate);
  const [version, setVersion] = useState(publication.yourVersion);
  const latest = publication.versions[0];
  const behind = latest !== undefined && version < latest.version;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <RefreshCwIcon aria-hidden className="size-3.5 text-muted-foreground" />
          {behind
            ? `v${latest.version} is out. You have v${version}.`
            : autoUpdate && latest
              ? `Auto-updated to v${version} ${latest.when}`
              : `You have the latest, v${version}`}
        </span>
        {latest ? (
          <span className="text-xs text-muted-foreground">
            {latest.author}: “{latest.note}”
          </span>
        ) : null}
      </div>
      {behind ? (
        <Button
          size="sm"
          onClick={() => {
            setVersion(latest.version);
            toastManager.add({ title: `Updated to v${latest.version}`, timeout: 2000 });
          }}
        >
          Update to v{latest.version}
        </Button>
      ) : null}
      <label className="flex shrink-0 items-center gap-2 text-sm text-foreground">
        <Switch checked={autoUpdate} onCheckedChange={setAutoUpdate} />
        Auto-update
      </label>
    </div>
  );
}

export function VersionHistory(props: { publication: SkillPublication }) {
  return (
    <SettingsSection title="Versions">
      {props.publication.versions.map((version, index) => (
        <div key={version.version} className="flex items-baseline gap-3 px-3 py-2.5 sm:px-4">
          <span className="w-7 shrink-0 font-mono text-xs text-foreground tabular-nums">
            v{version.version}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-foreground">“{version.note}”</span>
            <span className="text-xs text-muted-foreground">
              {version.author} · {version.when}
            </span>
          </div>
          {index === 0 ? (
            <Badge variant="secondary" size="sm">
              Latest
            </Badge>
          ) : null}
        </div>
      ))}
    </SettingsSection>
  );
}

export function Subscribers(props: { publication: SkillPublication }) {
  const { publication } = props;
  const latest = latestVersion(publication);
  const behind = subscribersBehind(publication).length;
  return (
    <SettingsSection
      title={`Synced to ${publication.subscribers.length} teammates`}
      headerAction={
        behind > 0 ? (
          <span className="text-xs text-muted-foreground">{behind} behind</span>
        ) : undefined
      }
    >
      {publication.subscribers.map((subscriber) => (
        <div key={subscriber.name} className="flex items-center gap-3 px-3 py-2 sm:px-4">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{subscriber.name}</span>
          <span className="text-xs text-muted-foreground">
            {subscriber.autoUpdate ? "auto-update" : "manual"}
          </span>
          <Badge variant={subscriber.version < latest ? "warning" : "outline"} size="sm">
            v{subscriber.version}
          </Badge>
        </div>
      ))}
    </SettingsSection>
  );
}

/** The git and registry plumbing, for people who want to see it. */
export function AdvancedSource(props: { publication: SkillPublication }) {
  const { publication } = props;
  const [open, setOpen] = useState(false);
  const skillName = publication.repoPath.split("/")[0] ?? publication.skillId;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded-sm px-3 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 transition-transform duration-150", open && "rotate-90")}
        />
        Advanced: backed by repo {publication.repo} · skills.sh
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <dl className="mx-3 mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 rounded-lg bg-muted/40 p-3 text-xs sm:mx-4">
          <dt className="text-muted-foreground">Repository</dt>
          <dd className="truncate font-mono text-foreground">{publication.repo}</dd>
          <dt className="text-muted-foreground">File</dt>
          <dd className="truncate font-mono text-foreground">{publication.repoPath}</dd>
          <dt className="text-muted-foreground">Registry</dt>
          <dd className="truncate font-mono text-foreground">{publication.registry}</dd>
          <dt className="text-muted-foreground">Install</dt>
          <dd className="truncate font-mono text-foreground">
            npx skills add {publication.repo} --skill {skillName}
          </dd>
        </dl>
        <p className="mx-3 mt-2 text-xs text-muted-foreground sm:mx-4">
          Each publish is a commit to this repo. Teammates never need git; Signalbox pulls new
          versions for them.
        </p>
      </CollapsiblePanel>
    </Collapsible>
  );
}
