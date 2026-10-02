/**
 * A real thread in the Home tree, in the shared item-row anatomy: type icon
 * (the Chat/Task toggle), title, the Pipeline's status, a lock when it is
 * private inside a shared container, and age; Done or Archive on hover. The
 * harness, branch, and worktree live in the details tooltip. Management beyond
 * that (Later, reorder) stays in the Pipeline.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ClockIcon, FolderClosedIcon, FolderGit2Icon, GitBranchIcon } from "lucide-react";
import { memo, useCallback, type ReactNode } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { readEnvironmentSupportsSettlement } from "../../state/entities";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { MiddleTruncate } from "../ui/middle-truncate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { HomeItemRow } from "./sections/HomeItemRow";
import { statusForThread, type HomeItemStatus } from "./sections/homeStatus";
import { defaultScopeFor } from "../multiplayer/sharing";
import { currentPerson } from "../multiplayer/teamThreads";
import { THREAD_STATUS_DISPLAY } from "../threadStatusDisplay";
import type { RowPlace } from "./sections/HomeItems";
import { useItemScope } from "./sections/useItemScope";
import { ScopeMarker } from "./sections/StatusMarkers";
import { classifyThread, useThreadKind } from "./sections/threadKind";
import { EMPTY_PROVIDER_ENTRIES, homeThreadKey } from "./useHomeSidebarData";

export type ArchiveHomeThread = (thread: EnvironmentThreadShell) => void;

/**
 * Archive the way the Pipeline does: where the server supports settling, Archive
 * is a settle (undo lives in the sidebar notice; the thread comes back on its
 * own when the agent needs you). Older servers fall back to the server archive
 * with the Pipeline's confirmation setting and Home's Undo toast.
 */
export function useArchiveHomeThread(): ArchiveHomeThread {
  const { archiveThread, settleThread, unarchiveThread } = useThreadActions();
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  return useCallback(
    (thread) => {
      void (async () => {
        if (readEnvironmentSupportsSettlement(thread.environmentId)) {
          const result = await settleThread(scopeThreadRef(thread.environmentId, thread.id));
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to archive thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        if (confirmThreadArchive) {
          const api = readLocalApi();
          if (!api) return;
          const confirmed = await settlePromise(() =>
            api.dialogs.confirm(`Archive thread "${thread.title}"?`),
          );
          if (confirmed._tag === "Failure" || !confirmed.value) return;
        }
        let didArchive = false;
        const result = await archiveThread(scopeThreadRef(thread.environmentId, thread.id), {
          onArchived: () => {
            didArchive = true;
          },
        });
        if (result._tag === "Success") {
          toastManager.add({
            id: `home-archive-${thread.id}`,
            type: "success",
            title: `Archived ${thread.title}`,
            timeout: 5000,
            actionProps: {
              children: "Undo",
              onClick: () => void unarchiveThread(scopeThreadRef(thread.environmentId, thread.id)),
            },
          });
        }
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: didArchive
                ? "Thread archived, but navigation failed"
                : "Failed to archive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [archiveThread, confirmThreadArchive, settleThread, unarchiveThread],
  );
}

function resolveHarness(
  thread: EnvironmentThreadShell,
  providerEntries: ReadonlyMap<string, ProviderInstanceEntry>,
) {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const entry = providerEntries.get(instanceId) ?? null;
  const model = entry?.models.find((candidate) => candidate.slug === thread.modelSelection.model);
  return {
    entry,
    displayName: entry?.displayName ?? thread.session?.providerName ?? instanceId,
    showInstanceBadge: entry !== null && shouldShowInstanceBadge(entry, providerEntries.values()),
    modelLabel: model ? getTriggerDisplayModelLabel(model) : thread.modelSelection.model,
  };
}

type Harness = ReturnType<typeof resolveHarness>;

function DetailLine(props: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-3 shrink-0 items-center justify-center">{props.icon}</span>
      <div className="flex min-w-0 truncate text-foreground/75">{props.children}</div>
    </div>
  );
}

/** Mounted only while the tooltip is open, so rows pay nothing for it at rest. */
function HomeThreadDetails(props: {
  thread: EnvironmentThreadShell;
  projectName: string | null;
  harness: Harness;
  status: HomeItemStatus | null;
}) {
  const { thread, harness } = props;
  const statusInfo = props.status ? THREAD_STATUS_DISPLAY[props.status] : null;
  const worktreePath = thread.worktreePath?.trim();
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
        {thread.title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
        {props.projectName ? (
          <DetailLine icon={<FolderClosedIcon className="size-3" />}>
            {props.projectName}
          </DetailLine>
        ) : null}
        {harness.entry ? (
          <DetailLine
            icon={
              <ProviderInstanceIcon
                driverKind={harness.entry.driverKind}
                displayName={harness.displayName}
                iconClassName="size-3 grayscale opacity-60"
              />
            }
          >
            {harness.showInstanceBadge
              ? `${harness.modelLabel} · ${harness.displayName}`
              : harness.modelLabel}
          </DetailLine>
        ) : null}
        {thread.branch ? (
          <DetailLine icon={<GitBranchIcon className="size-3" />}>
            <MiddleTruncate value={thread.branch} className="flex" />
          </DetailLine>
        ) : null}
        {worktreePath ? (
          <DetailLine icon={<FolderGit2Icon className="size-3" />}>
            <MiddleTruncate value={formatWorktreePathForDisplay(worktreePath)} className="flex" />
          </DetailLine>
        ) : null}
        {statusInfo ? (
          <DetailLine icon={<statusInfo.icon className={`size-3 ${statusInfo.className}`} />}>
            {statusInfo.description}
          </DetailLine>
        ) : null}
        <DetailLine icon={<ClockIcon className="size-3" />}>
          Active {formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt)}
        </DetailLine>
      </div>
    </div>
  );
}

export const HomeThreadRow = memo(function HomeThreadRow(props: {
  thread: EnvironmentThreadShell;
  isActive: boolean;
  projectName: string | null;
  providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onArchive: ArchiveHomeThread;
  /** Where the row sits; `null` (search results) shows no scope marker and no moves. */
  place: RowPlace | null;
}) {
  const { thread } = props;
  const threadKey = homeThreadKey(thread);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const status = statusForThread(thread, lastVisitedAt);
  const harness = resolveHarness(thread, props.providerEntries);
  const { kind: classified, switchNote } = classifyThread({
    title: thread.title,
    hasWorkspace: thread.branch != null || thread.worktreePath != null,
  });
  const { kind, overridden } = useThreadKind(threadKey, classified);
  const containerId = props.place?.containerId ?? "home";
  const scope = useItemScope({
    id: thread.id,
    title: thread.title,
    kind,
    containerId,
    ownerIds: [currentPerson.id],
    repliedIds: [],
    initialVisibility: defaultScopeFor(containerId),
  });

  return (
    <HomeItemRow
      type={kind}
      title={thread.title}
      isActive={props.isActive}
      onOpen={() => props.onOpen(scopeThreadRef(thread.environmentId, thread.id))}
      kind={{ kindKey: threadKey, kind, classified, overridden, switchNote }}
      status={status}
      markers={props.place ? <ScopeMarker scope={scope} /> : null}
      movable={{ kind: "item", key: threadKey, label: thread.title }}
      containerKey={props.place?.containerKey ?? ""}
      lastActiveAt={thread.latestUserMessageAt ?? thread.updatedAt}
      onArchive={() => props.onArchive(thread)}
      details={
        <HomeThreadDetails
          thread={thread}
          projectName={props.projectName}
          harness={harness}
          status={status}
        />
      }
    />
  );
});

/** Row inputs shared by every thread in the tree. */
export interface HomeThreadRowContext {
  readonly activeThreadKey: string | null;
  readonly providerEntriesByEnvironment: ReadonlyMap<
    string,
    ReadonlyMap<string, ProviderInstanceEntry>
  >;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
  readonly onArchiveThread: ArchiveHomeThread;
}

export function renderHomeThreadRow(
  thread: EnvironmentThreadShell,
  projectName: string | null,
  context: HomeThreadRowContext,
  place: RowPlace | null = null,
) {
  const threadKey = homeThreadKey(thread);
  return (
    <HomeThreadRow
      key={threadKey}
      thread={thread}
      isActive={threadKey === context.activeThreadKey}
      projectName={projectName}
      providerEntries={
        context.providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
      }
      onOpen={context.onOpenThread}
      onArchive={context.onArchiveThread}
      place={place}
    />
  );
}
