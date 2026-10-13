/**
 * Levels: the Home hierarchy as access. Each folder has an agent; connections,
 * skills, and plugins sit at one or more levels, and an agent can only use
 * what `levels.ts` lets it reach. Opening a level shows LevelDetail.
 */
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { placedAt } from "../levels/levelAccess";
import { useLevelAgentName, useLevelOptionsContext } from "../levels/LevelOptionsProvider";
import { countThings, useLeveledThings, type ThingKind } from "../levels/leveledThings";
import type { LevelOption } from "../levels/levelOptions";
import { SettingsSection } from "../settings/settingsLayout";
import { LevelDetail, type LevelTab } from "./LevelDetail";
import { presetsAt } from "./LevelNewcomers";
import { ManagedNote } from "./levelPrimitives";
import { LEVEL_POLICIES } from "./levelPolicyFixtures";
import { hasRestrictions } from "./levelPolicyModel";

const KIND_ORDER: readonly ThingKind[] = ["connections", "apis", "models", "skills", "plugins"];

function LevelRow(props: { level: LevelOption; counts: ReadonlyMap<ThingKind, number> }) {
  const { level } = props;
  const agentName = useLevelAgentName();
  const policy = LEVEL_POLICIES.find((entry) => entry.level === level.key);
  const summary = KIND_ORDER.flatMap((kind) => {
    const count = props.counts.get(kind) ?? 0;
    return count > 0 ? [countThings(count, kind)] : [];
  });
  return (
    <Link
      to="/plugins"
      search={{ section: "levels", group: level.key }}
      className="flex items-center gap-4 py-2.5 pr-3 outline-none hover:bg-accent/40 focus-visible:bg-accent/40 sm:pr-4"
      // Indent by depth so the list reads like the Home tree.
      style={{ paddingLeft: `${0.75 + level.depth * 1}rem` }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{level.name}</span>
          <span className="truncate text-xs text-muted-foreground">{agentName(level.key)}</span>
          {policy && hasRestrictions(policy) ? <ManagedNote policy={policy} /> : null}
        </div>
        <span className="truncate text-xs text-muted-foreground tabular-nums">
          {summary.length > 0 ? summary.join(" · ") : "Nothing placed here"}
        </span>
      </div>
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}

export function LevelsSection(props: {
  levelKey: string | undefined;
  tab: LevelTab | undefined;
  item: string | undefined;
}) {
  const options = useLevelOptionsContext();
  const things = useLeveledThings();
  const selected = props.levelKey
    ? options.find((option) => option.key === props.levelKey)
    : undefined;
  if (selected) {
    return (
      <LevelDetail
        key={selected.key}
        level={selected}
        things={things}
        tab={props.tab ?? "here"}
        item={props.item}
      />
    );
  }

  // Projects only show once something sits there, so a long project list stays out of the way.
  const rows = options.flatMap((level) => {
    const here = placedAt(things, level.key);
    if (level.kind === "project" && here.length === 0 && presetsAt(level.key).length === 0) {
      return [];
    }
    const counts = new Map<ThingKind, number>();
    for (const thing of here) counts.set(thing.kind, (counts.get(thing.kind) ?? 0) + 1);
    return [{ level, counts }];
  });

  return (
    <div className="flex flex-col gap-8">
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        Every folder in Home has an agent that represents it. Put a connection or skill at a level
        to give that agent access, and make it available to folders inside to share it further down.
        For anything it can't use, it has to ask another agent.
      </p>
      <SettingsSection title="Levels">
        {rows.map((row) => (
          <LevelRow key={row.level.key} level={row.level} counts={row.counts} />
        ))}
      </SettingsSection>
    </div>
  );
}
