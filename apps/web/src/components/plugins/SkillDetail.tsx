/**
 * One skill. You edit your own in place: personal skills save locally,
 * published ones publish a new version to everyone who has them. Skills
 * from teammates show your synced copy, versions, and who has it.
 */
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, PencilIcon, Share2Icon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { GroupBadges, groupById, orgGroup } from "./groupPrimitives";
import type { HarnessId, Skill } from "./pluginsModel";
import { HarnessToggles } from "./pluginsPrimitives";
import { SkillPublishDialog, StopSharingDialog } from "./SkillSharingDialogs";
import { publicationFor } from "./skillSharingFixtures";
import { isOwnedByYou, latestVersion, type SkillPublication } from "./skillSharingModel";
import { AdvancedSource, Subscribers, SyncStatus, VersionHistory } from "./SkillSharingParts";

function draftBody(skill: Skill) {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n`;
}

function SkillEditor(props: {
  skill: Skill;
  publication: SkillPublication | undefined;
  onDone: () => void;
}) {
  const initial = props.publication?.body ?? draftBody(props.skill);
  const [body, setBody] = useState(initial);
  const [note, setNote] = useState("");
  const next = props.publication ? latestVersion(props.publication) + 1 : null;
  const save = () => {
    toastManager.add(
      props.publication && next !== null
        ? {
            title: `Published ${props.skill.name} v${next}`,
            description: `Syncing to ${props.publication.subscribers.length} teammates.`,
            timeout: 3000,
          }
        : { title: `Saved ${props.skill.name}`, timeout: 2000 },
    );
    props.onDone();
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">Edit SKILL.md</h3>
        {next !== null ? (
          <span className="font-mono text-xs text-muted-foreground">
            v{next - 1} → v{next}
          </span>
        ) : null}
      </div>
      <textarea
        value={body}
        onChange={(event) => setBody(event.currentTarget.value)}
        aria-label={`${props.skill.name} SKILL.md`}
        spellCheck={false}
        className="field-sizing-content min-h-40 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {next !== null ? (
          <Input
            size="sm"
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            placeholder="What changed, e.g. handle missing VAT number"
            aria-label="What changed"
          />
        ) : null}
        <div className="flex shrink-0 justify-end gap-2 sm:ms-auto">
          <Button size="sm" variant="ghost" onClick={props.onDone}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={body === initial || (next !== null && !note.trim())}
            onClick={save}
          >
            {next !== null ? `Save & publish v${next}` : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SkillDetail(props: { skill: Skill }) {
  const { skill } = props;
  const publication = publicationFor(skill.id);
  const owned = publication ? isOwnedByYou(publication) : skill.source === "personal";
  const [editing, setEditing] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [harnesses, setHarnesses] = useState<readonly HarnessId[]>(skill.harnesses);
  const org = orgGroup();
  const group = publication ? groupById(publication.groupId) : undefined;
  const canPublish = !publication && skill.source === "personal" && org !== undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 px-3 sm:px-4">
        <Button
          size="xs"
          variant="ghost-muted"
          className="self-start"
          render={<Link to="/plugins" search={{ section: "skills" }} />}
        >
          <ArrowLeftIcon aria-hidden />
          All skills
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-lg font-semibold text-foreground">{skill.name}</h2>
              <GroupBadges groups={skill.groups} />
              {publication ? (
                <Badge variant="outline" size="sm">
                  v{latestVersion(publication)}
                </Badge>
              ) : null}
            </div>
            <p className="max-w-prose text-sm text-muted-foreground">{skill.description}</p>
            {publication ? (
              <p className="text-xs text-muted-foreground">
                {owned ? "You publish this" : `Published by ${publication.owner}`} to everyone in{" "}
                {group?.name ?? publication.groupId}.
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {owned && !editing ? (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <PencilIcon aria-hidden />
                Edit
              </Button>
            ) : null}
            {canPublish ? (
              <Button size="sm" variant="outline" onClick={() => setPublishOpen(true)}>
                <Share2Icon aria-hidden />
                Publish to {org.name}
              </Button>
            ) : null}
            {publication && owned ? (
              <Button size="sm" variant="ghost-destructive" onClick={() => setStopOpen(true)}>
                Stop sharing
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          Available to
          <HarnessToggles
            itemName={skill.name}
            enabled={harnesses}
            onToggle={(harness) =>
              setHarnesses((current) =>
                current.includes(harness)
                  ? current.filter((entry) => entry !== harness)
                  : [...current, harness],
              )
            }
          />
        </div>
      </div>

      {editing ? (
        <SkillEditor skill={skill} publication={publication} onDone={() => setEditing(false)} />
      ) : null}
      {publication && !owned ? <SyncStatus publication={publication} /> : null}

      {publication ? (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <VersionHistory publication={publication} />
            <Subscribers publication={publication} />
          </div>
          <AdvancedSource publication={publication} />
        </>
      ) : skill.source === "personal" ? null : (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          {skill.source === "skills.sh"
            ? `Installed from skills.sh (${skill.origin ?? "unknown"}). Updates come from its author.`
            : `Comes with ${skill.origin ?? "its source"}.`}
        </p>
      )}

      <SkillPublishDialog
        skillName={publishOpen ? skill.name : null}
        onOpenChange={setPublishOpen}
      />
      <StopSharingDialog
        skillId={stopOpen ? skill.id : null}
        skillName={skill.name}
        onOpenChange={setStopOpen}
      />
    </div>
  );
}
