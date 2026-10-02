/**
 * A multiplayer chat or task: a team-project thread, a loose Home item, a
 * private fork, or a new draft (every draft has its own `draft-…` id). The
 * header carries the Chat/Task toggle, container crumbs that open your agents,
 * the access bar and the reply mode. The conversation renders in the real chat
 * timeline (`SharedTimeline`). Kind and visibility are independent; visibility
 * starts from the container's default. Private items show their whole history.
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { ThreadKindIcon } from "../sidebar/sections/ThreadKindIcon";
import { useThreadKind } from "../sidebar/sections/threadKind";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AgentWaitingRow, approvalBanner, TypingRow } from "./AgentStatusRows";
import { startAgentTurn } from "./agentReply";
import { useAgentWait } from "./agentWait";
import { ContainerCrumbs } from "./ContainerCrumbs";
import { toastManager } from "../ui/toast";
import { applyDraftShare } from "./draftIntake";
import { teamThreadAccessBase, useAccessItem } from "./itemAccess";
import { logTeamEvent, useLocalTeamMessages } from "./localMessages";
import { unansweredMentions } from "./mentions";
import {
  NEW_ITEM_IDS,
  firstName,
  isDraftThreadId,
  isLegacyDraftThreadId,
  newDraftThreadId,
  type HarnessRef,
  type SharedThreadSearch,
  type TeamMessage,
} from "./multiplayerModel";
import { useReplyMode, waitingForReplies } from "./replyMode";
import { ReplyModeMenu } from "./ReplyModeMenu";
import { ProfileContainerContext } from "./PersonProfile";
import { containerInfo, hasAccess, peopleWithAccess, sharingTeamId } from "./sharing";
import { SharedTimeline } from "./SharedTimeline";
import { SURFACE_HEADER_CONTAINER, SurfaceHeaderActions } from "./SurfaceHeaderActions";
import { TeamComposer } from "./TeamComposer";
import { buildTeamTimeline } from "./teamTimeline";
import {
  HOME_CONTAINER_ID,
  currentPerson,
  findPerson,
  findTeam,
  findTeamProject,
  messagesForThread,
  resolveSharedThread,
  type ResolvedSharedThread,
} from "./teamThreads";
import { ThreadAccessBar } from "./ThreadAccessBar";
import { useAccessControls } from "./useAccessControls";

/** Home container key for a container id, e.g. for new rooms opened from here. */
function containerKeyOf(containerId: string): string {
  if (containerId === HOME_CONTAINER_ID) return "root";
  return findTeamProject(containerId) ? `team-project:${containerId}` : `section:${containerId}`;
}

const DEFAULT_HARNESS: HarnessRef = { provider: "codex", model: "GPT-5.4" };

/** The harness that answered last; new answers come from it. */
function lastHarness(messages: readonly TeamMessage[]): HarnessRef {
  for (const message of messages.toReversed()) {
    if (message.author.kind === "agent" && message.author.harness) return message.author.harness;
  }
  return DEFAULT_HARNESS;
}

/** Rendered rows carry their message id; jump if it's on screen. */
function jumpToMessage(threadId: string, messageId: string) {
  document
    .querySelector(`[data-message-id="${CSS.escape(`${threadId}:${messageId}`)}"]`)
    ?.scrollIntoView({ block: "start" });
}

function SharedThreadView(props: { resolved: ResolvedSharedThread; initialPrompt: string }) {
  const { thread, isDraft, containerId } = props.resolved;
  const container = containerInfo(containerId);
  const teamId = sharingTeamId(containerId);
  const teamName = (teamId ? findTeam(teamId)?.name : null) ?? container.name;
  const base = useMemo(() => teamThreadAccessBase(thread, containerId), [thread, containerId]);
  const item = useAccessItem(base);
  const controls = useAccessControls(item);
  const isPrivate = item.visibility === "private";
  const kind = useThreadKind(thread.id, thread.kind);

  const localMessages = useLocalTeamMessages(thread.id);
  const messages = useMemo(
    () => [...(isDraft ? [] : messagesForThread(thread)), ...localMessages],
    [isDraft, localMessages, thread],
  );
  const replyMode = useReplyMode(thread.id, thread.replyMode);
  const timeline = useMemo(
    () => buildTeamTimeline({ threadId: thread.id, messages, endsAt: thread.lastActiveAt }),
    [messages, thread.id, thread.lastActiveAt],
  );
  // The agent holds its answer for an explicit wait, else for the reply mode.
  const wait = useAgentWait(thread, messages);
  const modeWaiting = replyMode === "everyone" ? waitingForReplies(messages) : [];
  const waitingFor = wait.waitingFor.length > 0 ? wait.waitingFor : modeWaiting;
  const harness = lastHarness(messages);
  const [approvalDecided, setApprovalDecided] = useState(false);
  const approval = approvalDecided
    ? null
    : approvalBanner({
        threadId: thread.id,
        turn: timeline.activeTurn,
        onDecide: (decision) => {
          setApprovalDecided(true);
          toastManager.add({
            id: "turn-approval",
            type: "info",
            title:
              decision === "accept" || decision === "acceptForSession" ? "Approved" : "Declined",
            timeout: 2000,
          });
        },
      });
  const replyNow = () => {
    wait.stopWaiting();
    const lastPerson = messages.findLast((message) => message.author.kind === "person");
    startAgentTurn(thread.id, {
      harness,
      startedById:
        lastPerson?.author.kind === "person" ? lastPerson.author.personId : currentPerson.id,
      prompt: lastPerson?.body ?? thread.title,
    });
  };
  // A Chat/Task flip from the header shows in the timeline, like a renamed group chat.
  const shownKind = useRef(kind.kind);
  useEffect(() => {
    if (shownKind.current === kind.kind) return;
    shownKind.current = kind.kind;
    logTeamEvent(thread.id, "kind", `${firstName(currentPerson.name)} made this a ${kind.kind}`);
  }, [kind.kind, thread.id]);
  const typing = !isPrivate && thread.typingId ? (findPerson(thread.typingId) ?? null) : null;
  const activeIds = [...(thread.presentIds ?? []), ...(typing ? [typing.id] : [])].filter((id) =>
    hasAccess(item, id),
  );

  return (
    <ProfileContainerContext value={containerKeyOf(containerId)}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className={SURFACE_HEADER_CONTAINER}>
          <WorkspaceBreadcrumb ariaLabel="Thread breadcrumb" className="flex-1">
            <ContainerCrumbs containerId={containerId} />
            <WorkspaceBreadcrumbItem current>
              <span className="flex min-w-0 items-center gap-1.5">
                <ThreadKindIcon
                  control={{
                    kindKey: thread.id,
                    kind: kind.kind,
                    classified: thread.kind,
                    overridden: kind.overridden,
                    switchNote: null,
                  }}
                  title={thread.title}
                />
                <WorkspaceBreadcrumbText>{thread.title}</WorkspaceBreadcrumbText>
              </span>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="flex shrink-0 items-center gap-1">
            <ThreadAccessBar
              controls={controls}
              activeIds={activeIds}
              pending={unansweredMentions(messages)}
              onJumpToMessage={(messageId) => jumpToMessage(thread.id, messageId)}
            />
            <ReplyModeMenu threadId={thread.id} mode={replyMode} />
            <SurfaceHeaderActions projectControls rightPanel="project" />
          </div>
        </WorkspacePageHeader>

        {messages.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center gap-2 px-4 pt-16 text-center">
            <h1 className="text-base font-semibold">
              New {kind.kind} in {container.name}
            </h1>
            <p className="max-w-sm text-sm text-muted-foreground text-pretty">
              {isPrivate ? "Only you and people you add see it." : `${teamName} can read along.`}
            </p>
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <SharedTimeline threadKey={thread.id} timeline={timeline} />
            {waitingFor.length > 0 && !timeline.activeTurn ? (
              <AgentWaitingRow
                harness={harness}
                waitingFor={waitingFor}
                onReplyNow={replyNow}
                onStopWaiting={wait.waitingFor.length > 0 ? wait.stopWaiting : undefined}
              />
            ) : null}
            {typing ? <TypingRow person={typing} /> : null}
          </div>
        )}

        <div className="shrink-0 px-4 pb-4">
          <TeamComposer
            itemId={thread.id}
            containerId={containerId}
            hasAccess={(personId) => hasAccess(item, personId)}
            onShareAndNotify={controls.shareAndNotify}
            messages={messages}
            replyMode={replyMode}
            harness={harness}
            initialPrompt={props.initialPrompt}
            waitingFor={wait.waitingFor}
            waitCandidates={peopleWithAccess(item).filter(
              (person) => person.id !== currentPerson.id,
            )}
            onWaitFor={wait.waitFor}
            approvalBanner={approval}
          />
        </div>
      </div>
    </ProfileContainerContext>
  );
}

export function SharedThreadPage(props: { threadId: string; search: SharedThreadSearch }) {
  const navigate = useNavigate();
  const { project, kind, prompt, share } = props.search;
  const isLegacy = isLegacyDraftThreadId(props.threadId);
  // `?prompt=` and `?share=` apply once, then leave the URL (like /assistant).
  const [initialPrompt] = useState(prompt ?? "");
  useEffect(() => {
    if (isLegacy || (prompt === undefined && share === undefined)) return;
    if (share && isDraftThreadId(props.threadId)) applyDraftShare(props.threadId, share);
    void navigate({
      to: "/shared/$threadId",
      params: { threadId: props.threadId },
      search: { ...(project ? { project } : {}), ...(kind ? { kind } : {}) },
      replace: true,
    });
  }, [isLegacy, kind, navigate, project, prompt, props.threadId, share]);
  // Old shared draft ids open a fresh draft so no two drafts share state.
  useEffect(() => {
    if (!isLegacy) return;
    void navigate({
      to: "/shared/$threadId",
      params: { threadId: newDraftThreadId() },
      search: {
        ...(project ? { project } : {}),
        kind: kind ?? (props.threadId === NEW_ITEM_IDS.task ? "task" : "chat"),
        ...(prompt ? { prompt } : {}),
        ...(share ? { share } : {}),
      },
      replace: true,
    });
  }, [isLegacy, kind, navigate, project, prompt, props.threadId, share]);
  const resolved = useMemo(
    () =>
      isLegacy
        ? null
        : resolveSharedThread(props.threadId, {
            ...(project ? { project } : {}),
            ...(kind ? { kind } : {}),
          }),
    [isLegacy, kind, project, props.threadId],
  );
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      {resolved ? (
        <SharedThreadView
          key={resolved.thread.id}
          resolved={resolved}
          initialPrompt={initialPrompt}
        />
      ) : isLegacy ? null : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <h1 className="text-base font-semibold">This chat isn't here</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            It may be private to someone else, or it was removed.
          </p>
        </div>
      )}
    </SidebarInset>
  );
}
