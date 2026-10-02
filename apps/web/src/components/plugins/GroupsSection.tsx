/**
 * Groups: which bundles of access exist, what is in each, and which sidebar
 * sections hand them to agents. Opening a group shows GroupDetail.
 */
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { sectionPathLabel } from "../sidebar/sections/sectionModel";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { GroupDetail, sectionsUsing, type GroupTab } from "./GroupDetail";
import { GroupBadges, ManagedNote } from "./groupPrimitives";
import { GROUP_SOURCES, GROUPS, SECTION_GROUP_USAGE } from "./groupsFixtures";
import {
  allGroupMembers,
  countByKind,
  GROUP_MEMBER_KIND_LABEL,
  hasRestrictions,
  membersOfGroup,
  type AccessGroup,
  type GroupMemberKind,
} from "./groupsModel";
import { comingSoon } from "./pluginsPrimitives";

const MEMBERS = allGroupMembers(GROUP_SOURCES);
const KIND_ORDER: readonly GroupMemberKind[] = [
  "connections",
  "apis",
  "models",
  "skills",
  "plugins",
];

function overridesLabel(count: number) {
  if (count === 0) return "Everything inside uses these groups";
  return `${count} ${count === 1 ? "chat or task overrides" : "chats or tasks override"} them`;
}

function GroupRow(props: { group: AccessGroup }) {
  const { group } = props;
  const counts = countByKind(membersOfGroup(MEMBERS, group.id));
  const usedBy = sectionsUsing(group.id);
  return (
    <Link
      to="/plugins"
      search={{ section: "groups", group: group.id }}
      className="flex items-center gap-4 px-3 py-3 outline-none hover:bg-accent/40 focus-visible:bg-accent/40 sm:px-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{group.name}</span>
          {hasRestrictions(group) ? <ManagedNote group={group} /> : null}
        </div>
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
          {KIND_ORDER.map((kind) => (
            <span key={kind}>
              <span className="text-foreground">{counts[kind]}</span>{" "}
              {GROUP_MEMBER_KIND_LABEL[kind].toLowerCase()}
            </span>
          ))}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          Used by{" "}
          {usedBy.map((usage) => sectionPathLabel(usage.sectionId)).join(", ") || "no sections"}
        </span>
      </div>
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}

export function GroupsSection(props: {
  groupId: string | undefined;
  tab: GroupTab | undefined;
  item: string | undefined;
}) {
  const selected = props.groupId ? GROUPS.find((group) => group.id === props.groupId) : undefined;
  if (selected) {
    return (
      <GroupDetail
        key={selected.id}
        group={selected}
        members={MEMBERS}
        tab={props.tab ?? "members"}
        item={props.item}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        Agents only get what the groups of their section include.
      </p>
      <SettingsSection title="Groups">
        {GROUPS.map((group) => (
          <GroupRow key={group.id} group={group} />
        ))}
      </SettingsSection>
      <SettingsSection title="Sections">
        {SECTION_GROUP_USAGE.map((usage) => (
          <div key={usage.sectionId} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-foreground">
                {sectionPathLabel(usage.sectionId)}
              </span>
              <span className="text-xs text-muted-foreground">
                {overridesLabel(usage.overrides)}
              </span>
            </div>
            <GroupBadges groups={usage.groups} />
            <Button
              size="xs"
              variant="ghost"
              onClick={() => comingSoon(`Change groups for ${sectionPathLabel(usage.sectionId)}`)}
            >
              Change
            </Button>
          </div>
        ))}
      </SettingsSection>
    </div>
  );
}
