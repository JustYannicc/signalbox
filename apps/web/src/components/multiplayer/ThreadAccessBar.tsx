/**
 * Google-Docs-style access in a page header: the others who can see this item
 * (people here now first, with a presence dot), "Waiting on Samir" / "Needs you",
 * and a Share button whose icon says private or shared. Avatars and Share both
 * open the Share dialog. In the chat header it collapses to the avatars when
 * narrow (`@container/header-actions`).
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AtSignIcon, LockIcon, UsersIcon } from "lucide-react";
import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useContainerIdForThread } from "../sidebar/sections/containerIds";
import { classifyThreadKind, useThreadKind } from "../sidebar/sections/threadKind";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { localThreadAccessBase, useAccessItem } from "./itemAccess";
import { pendingMentionLabel } from "./mentions";
import type { TeamPerson } from "./multiplayerModel";
import { PersonAvatar } from "./PersonAvatar";
import { joinNames, peopleWithAccess, sharingTeamId } from "./sharing";
import { currentPerson, findTeam } from "./teamThreads";
import { useAccessControls, type AccessControls } from "./useAccessControls";

const MAX_AVATARS = 4;
/** Hidden when the chat header is narrow; no effect in other headers. */
const COLLAPSIBLE = "flex @max-lg/header-actions:hidden";

export interface AccessBarPending {
  readonly person: TeamPerson;
  /** Jump target, when the wait comes from a message. */
  readonly messageId?: string;
}

function PresenceStack(props: { people: readonly TeamPerson[]; activeIds: ReadonlySet<string> }) {
  const shown = props.people.slice(0, MAX_AVATARS);
  const overflow = props.people.length - shown.length;
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map((person) => (
        <span key={person.id} className="relative flex">
          <PersonAvatar person={person} size="sm" ringClassName="ring-2 ring-background" />
          {props.activeIds.has(person.id) ? (
            <span
              aria-hidden
              className="absolute -right-px -bottom-px size-2 rounded-full bg-success ring-2 ring-background"
            />
          ) : null}
        </span>
      ))}
      {overflow > 0 ? (
        <span
          aria-hidden
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground ring-2 ring-background"
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

export function ThreadAccessBar(props: {
  controls: AccessControls;
  /** Others on this item right now. */
  activeIds?: readonly string[];
  /** Mentions or rooms waiting on someone, you included. */
  pending?: readonly AccessBarPending[];
  onJumpToMessage?: (messageId: string) => void;
}) {
  const { item, openShareDialog } = props.controls;
  const activeIds = new Set(props.activeIds ?? []);
  const others = peopleWithAccess(item)
    .filter((person) => person.id !== currentPerson.id)
    .toSorted((left, right) => Number(activeIds.has(right.id)) - Number(activeIds.has(left.id)));
  const hereNow = others.filter((person) => activeIds.has(person.id));
  const teamId = sharingTeamId(item.containerId);
  const isShared = item.visibility === "shared" && teamId !== null;
  const scope = isShared
    ? `Anyone in ${(teamId ? findTeam(teamId)?.name : null) ?? "the team"}`
    : others.length > 0
      ? "Only people added"
      : "Private";
  const summary = `${joinNames(others, "")} ${others.length === 1 ? "has" : "have"} access${
    hereNow.length > 0 ? ` · ${joinNames(hereNow, "")} here now` : ""
  }`;

  return (
    // Headers open their own context menu; the bar and its dialogs keep the native one.
    <div
      className="flex shrink-0 items-center gap-2"
      onContextMenu={(event) => {
        event.stopPropagation();
      }}
    >
      {(props.pending ?? []).slice(0, 2).map((pending) => {
        const { messageId } = pending;
        const onJump = props.onJumpToMessage;
        return (
          <span key={pending.person.id} className={COLLAPSIBLE}>
            <Badge
              variant={pending.person.id === currentPerson.id ? "warning" : "info"}
              {...(messageId && onJump
                ? { render: <button type="button" onClick={() => onJump(messageId)} /> }
                : {})}
            >
              <AtSignIcon />
              {pendingMentionLabel(pending)}
            </Badge>
          </span>
        );
      })}
      {others.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`${summary}. Open sharing.`}
                onClick={openShareDialog}
                className="flex cursor-pointer items-center rounded-full outline-hidden ring-ring focus-visible:ring-2"
              />
            }
          >
            <PresenceStack people={others} activeIds={activeIds} />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{summary}</TooltipPopup>
        </Tooltip>
      ) : null}
      <span className={COLLAPSIBLE}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                aria-label={`Share · ${scope}`}
                onClick={openShareDialog}
              />
            }
          >
            {isShared ? <UsersIcon /> : <LockIcon />}
            Share
          </TooltipTrigger>
          <TooltipPopup side="bottom">{scope}</TooltipPopup>
        </Tooltip>
      </span>
      {props.controls.dialogs}
    </div>
  );
}

/**
 * The access bar for a real thread. Placeholder until threads have owners:
 * access is just you; container and kind are the ones Home shows (moves and
 * Chat/Task flips included), so the top bar and the sidebar marker agree.
 */
export function LocalThreadAccessBar(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  title: string;
  project: EnvironmentProject | null;
}) {
  const { project } = props;
  const threadKey = scopedThreadKey(scopeThreadRef(props.environmentId, props.threadId));
  const { kind } = useThreadKind(threadKey, classifyThreadKind({ title: props.title }));
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const containerId = useContainerIdForThread({
    threadKey,
    project: project
      ? {
          projectKey: deriveLogicalProjectKeyFromSettings(project, groupingSettings),
          displayName: project.title,
          workspaceRoot: project.workspaceRoot,
        }
      : null,
  });
  const base = useMemo(
    () =>
      localThreadAccessBase({ threadId: props.threadId, title: props.title, kind, containerId }),
    [containerId, kind, props.threadId, props.title],
  );
  const controls = useAccessControls(useAccessItem(base));
  return <ThreadAccessBar controls={controls} />;
}
