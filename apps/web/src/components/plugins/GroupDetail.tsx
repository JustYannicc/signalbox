/**
 * One group: who may change what, its members by type, and what newcomers
 * get. Open by default; you only see actions you can take, and restricted
 * areas carry a single "Managed by … admins" note.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowUpRightIcon, PlusIcon, ShieldIcon } from "lucide-react";
import { useState } from "react";

import { SettingsSection } from "../settings/settingsLayout";
import { sectionPathLabel } from "../sidebar/sections/sectionModel";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { GroupNewcomers } from "./GroupNewcomers";
import { GroupBadges, ManagedNote } from "./groupPrimitives";
import { SECTION_GROUP_USAGE } from "./groupsFixtures";
import {
  canChangeMember,
  GROUP_MEMBER_KIND_LABEL,
  isRestricted,
  membersOfGroup,
  PERMISSION_AREA_LABEL,
  PERMISSION_AREAS,
  type AccessGroup,
  type GroupMember,
  type GroupMemberKind,
} from "./groupsModel";
import { comingSoon, HarnessGlyph, IntegrationMark } from "./pluginsPrimitives";

export type GroupTab = "members" | "newcomers";

const KIND_ORDER: readonly GroupMemberKind[] = [
  "connections",
  "apis",
  "models",
  "skills",
  "plugins",
];

export function sectionsUsing(groupId: string) {
  return SECTION_GROUP_USAGE.filter((usage) => usage.groups.includes(groupId));
}

function MemberRow(props: { group: AccessGroup; member: GroupMember; onRemove: () => void }) {
  const { member } = props;
  return (
    <div className="flex items-center gap-3 px-3 py-2 sm:px-4">
      {member.glyph ? (
        <IntegrationMark glyph={member.glyph} size="sm" />
      ) : member.harness ? (
        <span className="flex size-5 shrink-0 items-center justify-center">
          <HarnessGlyph harness={member.harness} />
        </span>
      ) : (
        <span aria-hidden className="size-5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{member.name}</span>
        <span className="truncate text-xs text-muted-foreground">{member.detail}</span>
      </div>
      {member.groups.length > 1 ? <GroupBadges groups={member.groups} /> : null}
      {member.kind === "models" ? (
        <Button size="xs" variant="ghost" render={<Link to="/accounts" />}>
          Open
          <ArrowUpRightIcon aria-hidden />
        </Button>
      ) : canChangeMember(props.group, member) ? (
        <Button size="xs" variant="ghost-destructive" onClick={props.onRemove}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}

function AddMemberMenu(props: { group: AccessGroup }) {
  const add = (what: string) => comingSoon(`Add ${what} to ${props.group.name}`);
  const open = (area: "connections" | "apis" | "plugins") => !isRestricted(props.group, area);
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        <PlusIcon aria-hidden />
        Add
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => add("your own account")}>Your own account</MenuItem>
        <MenuItem onClick={() => add("one of your skills")}>One of your skills</MenuItem>
        {open("connections") ? (
          <MenuItem onClick={() => add("a shared connection")}>Shared connection</MenuItem>
        ) : null}
        {open("apis") ? <MenuItem onClick={() => add("an API")}>API</MenuItem> : null}
        {open("plugins") ? (
          <MenuItem onClick={() => add("a plugin")}>Codex or Claude plugin</MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function PermissionsList(props: { group: AccessGroup }) {
  return (
    <SettingsSection title="Who can change what">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 px-3 py-3 text-sm sm:px-4">
        {PERMISSION_AREAS.map((area) => {
          const restricted = isRestricted(props.group, area);
          return (
            <div key={area} className="contents">
              <span className="text-foreground">{PERMISSION_AREA_LABEL[area]}</span>
              <span className="flex items-center justify-end gap-1.5 text-muted-foreground">
                {restricted ? <ShieldIcon aria-hidden className="size-3" /> : null}
                {restricted ? "Admins" : "Members"}
              </span>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}

function MembersTab(props: { group: AccessGroup; members: readonly GroupMember[] }) {
  const { group } = props;
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const members = membersOfGroup(props.members, group.id).filter(
    (member) => !removed.has(member.key),
  );
  const remove = (member: GroupMember) => {
    setRemoved((current) => new Set(current).add(member.key));
    toastManager.add({
      title: `Removed ${member.name} from ${group.name}`,
      description: "Agents in this group lose it on their next turn.",
      timeout: 3000,
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <PermissionsList group={group} />
      {KIND_ORDER.map((kind) => {
        const ofKind = members.filter((member) => member.kind === kind);
        return (
          <SettingsSection
            key={kind}
            title={`${GROUP_MEMBER_KIND_LABEL[kind]} (${ofKind.length})`}
            headerAction={
              kind === "models" ? (
                <Button size="xs" variant="ghost" render={<Link to="/accounts" />}>
                  Manage in Usage › Accounts
                  <ArrowUpRightIcon aria-hidden />
                </Button>
              ) : isRestricted(group, kind) ? (
                <ManagedNote group={group} />
              ) : undefined
            }
          >
            {ofKind.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
                None in {group.name}.
              </p>
            ) : (
              ofKind.map((member) => (
                <MemberRow
                  key={member.key}
                  group={group}
                  member={member}
                  onRemove={() => remove(member)}
                />
              ))
            )}
          </SettingsSection>
        );
      })}
    </div>
  );
}

export function GroupDetail(props: {
  group: AccessGroup;
  members: readonly GroupMember[];
  tab: GroupTab;
  item: string | undefined;
}) {
  const { group } = props;
  const navigate = useNavigate();
  const canRename = group.yourRole !== "Member";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 px-3 sm:px-4">
        <Button
          size="xs"
          variant="ghost-muted"
          className="self-start"
          render={<Link to="/plugins" search={{ section: "groups" }} />}
        >
          <ArrowLeftIcon aria-hidden />
          All groups
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">{group.name}</h2>
            <p className="text-sm text-muted-foreground">
              Your role: <span className="text-foreground">{group.yourRole}</span>
              {" · "}
              Used by{" "}
              {sectionsUsing(group.id)
                .map((usage) => sectionPathLabel(usage.sectionId))
                .join(", ") || "no sections"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canRename ? (
              <Button size="sm" variant="ghost" onClick={() => comingSoon(`Rename ${group.name}`)}>
                Rename
              </Button>
            ) : null}
            {props.tab === "members" ? <AddMemberMenu group={group} /> : null}
          </div>
        </div>
        <ToggleGroup
          aria-label="Group view"
          value={[props.tab]}
          onValueChange={(next) => {
            const tab = next[0] === "newcomers" ? "newcomers" : "members";
            void navigate({
              to: "/plugins",
              search: {
                section: "groups",
                group: group.id,
                ...(tab === "newcomers" ? { tab } : {}),
              },
            });
          }}
          className="self-start"
        >
          <Toggle value="members">Members</Toggle>
          <Toggle value="newcomers">What newcomers get</Toggle>
        </ToggleGroup>
      </div>

      {props.tab === "newcomers" ? (
        <GroupNewcomers group={group} presetId={props.item} />
      ) : (
        <MembersTab group={group} members={props.members} />
      )}
    </div>
  );
}
