/**
 * Skills: what agents load when a task matches, where each came from, and
 * which Home levels it sits at. Ticking the organization's level publishes a skill;
 * unticking it stops sharing. Open a skill for versions and harnesses.
 */
import { Link } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";

import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { LevelKey } from "../levels/levels";
import { setThingReach, toggleThingLevel, useLevelPlacementStore } from "../levels/leveledThings";
import { LevelBadges, LevelPicker } from "./levelPrimitives";
import { ORG_POLICY } from "./levelPolicyFixtures";
import { harnessRestriction, type Skill, type SkillSource } from "./pluginsModel";
import { SKILLS } from "./pluginsFixtures";
import { SkillDetail } from "./SkillDetail";
import { SkillPublishDialog, StopSharingDialog } from "./SkillSharingDialogs";
import { publicationFor } from "./skillSharingFixtures";
import { isOwnedByYou } from "./skillSharingModel";
import { SkillShareBadge } from "./SkillSharingParts";
import { SkillsFromRepo } from "./SkillsFromRepo";

type SourceFilter = SkillSource | "all";

const SOURCE_FILTERS: readonly { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "personal", label: "Personal" },
  { value: "team", label: "Team" },
  { value: "skills.sh", label: "skills.sh" },
  { value: "project", label: "Project" },
  { value: "plugin", label: "Plugin" },
];

const SOURCE_BADGE: Record<SkillSource, "secondary" | "info" | "outline"> = {
  personal: "secondary",
  project: "info",
  plugin: "outline",
  "skills.sh": "outline",
  team: "info",
};

/** Whose levels you may change: your own skills, not ones installed or shared to you. */
function isYours(skill: Skill) {
  const publication = publicationFor(skill.id);
  return publication ? isOwnedByYou(publication) : skill.source === "personal";
}

export function SkillsSection(props: { skillId?: string | undefined }) {
  const selected = props.skillId ? SKILLS.find((skill) => skill.id === props.skillId) : undefined;
  if (selected) return <SkillDetail key={selected.id} skill={selected} />;
  return <SkillList />;
}

function SkillList() {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [source, setSource] = useState<SourceFilter>("all");
  const overrides = useLevelPlacementStore((state) => state.levels);
  const levelsOf = (skill: Skill) => overrides[`skill:${skill.id}`] ?? skill.levels;
  const reachOverrides = useLevelPlacementStore((state) => state.reach);
  const [publishing, setPublishing] = useState<Skill | null>(null);
  const [stopping, setStopping] = useState<Skill | null>(null);
  const orgLevel = ORG_POLICY?.level;

  const setLevel = (skill: Skill, level: LevelKey, checked: boolean) =>
    toggleThingLevel(`skill:${skill.id}`, levelsOf(skill), level, checked);
  // The org's level is not a checkbox like the others: it is publishing and un-publishing.
  const toggleLevel = (skill: Skill, level: LevelKey, checked: boolean) => {
    if (level !== orgLevel) setLevel(skill, level, checked);
    else if (checked) setPublishing(skill);
    else setStopping(skill);
  };

  const visibleSkills = SKILLS.filter(
    (skill) =>
      (source === "all" || skill.source === source) &&
      (deferredQuery.length === 0 ||
        skill.name.toLowerCase().includes(deferredQuery) ||
        skill.description.toLowerCase().includes(deferredQuery)),
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        Agents load a skill when a task matches. Open one to edit or share it.
      </p>
      <SettingsSection title="Installed">
        <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:px-4">
          <Input
            type="search"
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search skills"
            aria-label="Search skills"
            className="sm:max-w-72"
          />
          <ToggleGroup
            aria-label="Skill source"
            value={[source]}
            onValueChange={(next) => {
              const value = SOURCE_FILTERS.find((filter) => filter.value === next[0]);
              if (value) setSource(value.value);
            }}
            className="sm:ms-auto"
          >
            {SOURCE_FILTERS.map((filter) => (
              <Toggle key={filter.value} value={filter.value}>
                {filter.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
        {visibleSkills.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No skills match “{query.trim()}”.
          </p>
        ) : (
          visibleSkills.map((skill) => {
            const restriction = harnessRestriction(skill.harnesses);
            const levels = levelsOf(skill);
            const reach = reachOverrides[`skill:${skill.id}`] ?? skill.reach ?? "here";
            return (
              <div
                key={skill.id}
                className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Link
                      to="/plugins"
                      search={{ section: "skills", skill: skill.id }}
                      className="truncate rounded-sm font-mono text-sm text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      {skill.name}
                    </Link>
                    <Badge variant={SOURCE_BADGE[skill.source]} size="sm">
                      {skill.origin ? `${skill.source}: ${skill.origin}` : skill.source}
                    </Badge>
                    <SkillShareBadge skillId={skill.id} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {skill.description}
                    {restriction ? ` · ${restriction}` : ""}
                  </p>
                </div>
                {isYours(skill) ? (
                  <LevelPicker
                    itemName={skill.name}
                    levels={levels}
                    onToggle={(level, checked) => toggleLevel(skill, level, checked)}
                    reach={reach}
                    onReachChange={(next) => setThingReach(`skill:${skill.id}`, next)}
                  />
                ) : (
                  <LevelBadges levels={levels} reach={reach} />
                )}
              </div>
            );
          })
        )}
      </SettingsSection>
      <SkillsFromRepo />

      <SkillPublishDialog
        skillName={publishing?.name ?? null}
        onOpenChange={(open) => {
          if (!open) setPublishing(null);
        }}
        onPublished={() => {
          if (publishing && orgLevel) setLevel(publishing, orgLevel, true);
        }}
      />
      <StopSharingDialog
        skillId={stopping?.id ?? null}
        skillName={stopping?.name ?? ""}
        onOpenChange={(open) => {
          if (!open) setStopping(null);
        }}
        onStopped={() => {
          if (stopping && orgLevel) setLevel(stopping, orgLevel, false);
        }}
      />
    </div>
  );
}
