/**
 * A room where two people's assistants talk on their owners' behalf: the
 * exchange, then the outcome. Each side's sharing policy sits behind the
 * shield. The header shows Pipeline status, who it waits on, and access (a
 * room starts with just its two owners; widening asks the other owner).
 * Archive and restore live in the header menu.
 */
import { ArchiveIcon, ArchiveRestoreIcon, EllipsisIcon, ShieldIcon } from "lucide-react";
import { useMemo } from "react";

import { isElectron } from "../../env";
import { cn } from "~/lib/utils";
import { AssistantAvatar } from "../assistant/avatar";
import { ContainerCrumbs } from "../multiplayer/ContainerCrumbs";
import { roomAccessBase, useAccessItem } from "../multiplayer/itemAccess";
import { useLocalRoomMessages } from "../multiplayer/localMessages";
import { firstName } from "../multiplayer/multiplayerModel";
import { useAssistantDirectory } from "../multiplayer/personAssistant";
import { ProfileContainerContext } from "../multiplayer/PersonProfile";
import { currentPerson, findPerson, peopleByIds } from "../multiplayer/teamThreads";
import { ThreadAccessBar } from "../multiplayer/ThreadAccessBar";
import { useAccessControls } from "../multiplayer/useAccessControls";
import { THREAD_STATUS_DISPLAY, type ThreadDisplayStatus } from "../threadStatusDisplay";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { RoomComposer } from "./RoomComposer";
import type { Room } from "./roomModel";
import { RoomMessageList } from "./RoomMessageList";
import { RoomPolicyStrip } from "./RoomPolicyStrip";
import {
  SURFACE_HEADER_CONTAINER,
  SurfaceHeaderActions,
} from "../multiplayer/SurfaceHeaderActions";
import { resolveRoom, useRoomArchiveStore } from "./rooms";

/** Pipeline status for the header; waits show as the access bar's badge instead. */
function roomStatus(room: Room): ThreadDisplayStatus | null {
  if (room.status === "done") return "done";
  return room.waitingOnId ? null : "working";
}

function RoomStatus(props: { room: Room; archived: boolean }) {
  if (props.archived) {
    return <span className="text-xs text-muted-foreground">Archived</span>;
  }
  const status = roomStatus(props.room);
  if (!status) return null;
  const info = THREAD_STATUS_DISPLAY[status];
  const Icon = info.icon;
  return (
    <span className={cn("flex items-center gap-1 text-xs", info.className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="max-sm:hidden">{info.label}</span>
    </span>
  );
}

function OutcomeCard(props: { outcome: NonNullable<Room["outcome"]> }) {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Shared", props.outcome.shared.join(", ") || "Nothing"],
    ["Not shared", props.outcome.declined.join(", ") || "Nothing"],
    ["Next", props.outcome.next],
  ];
  return (
    <section aria-label="Outcome" className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
      <h2 className="text-xs font-medium text-muted-foreground">Outcome</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The room with your local sends appended; once you answer, it waits on them. */
function useLiveRoom(fixture: Room, otherId: string | undefined): Room {
  const local = useLocalRoomMessages(fixture.id);
  return useMemo(() => {
    if (local.length === 0) return fixture;
    const { waitingOnId: _waiting, ...rest } = fixture;
    const waitsOnOther = fixture.status === "open" && otherId !== undefined;
    return {
      ...rest,
      messages: [...fixture.messages, ...local],
      ...(waitsOnOther ? { waitingOnId: otherId } : {}),
    };
  }, [fixture, local, otherId]);
}

function RoomView(props: { room: Room }) {
  const room = useLiveRoom(
    props.room,
    props.room.ownerIds.find((id) => id !== currentPerson.id),
  );
  const resolveAssistant = useAssistantDirectory();
  const archived = useRoomArchiveStore((state) => state.archived[room.id] === true);
  const owners = peopleByIds(room.ownerIds);
  const assistants = owners.map(resolveAssistant);
  const other = owners.find((person) => person.id !== currentPerson.id);
  const otherAssistant = other ? resolveAssistant(other) : null;
  const base = useMemo(() => roomAccessBase(props.room), [props.room]);
  const item = useAccessItem(base);
  const controls = useAccessControls(item);
  const waitingOn =
    room.status === "open" && room.waitingOnId ? findPerson(room.waitingOnId) : undefined;

  const setArchived = (next: boolean) => {
    useRoomArchiveStore.getState().setArchived(room.id, next);
    toastManager.add({
      id: "room-archive",
      type: "success",
      title: next ? "Room archived" : "Room restored",
      description: next ? "It stays readable from here." : undefined,
      timeout: 2000,
    });
  };

  return (
    <ProfileContainerContext value={room.containerKey}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className={SURFACE_HEADER_CONTAINER}>
          <WorkspaceBreadcrumb ariaLabel="Room breadcrumb" className="flex-1">
            <ContainerCrumbs containerId={room.containerKey} />
            <WorkspaceBreadcrumbItem current>
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex shrink-0 -space-x-1.5">
                  {assistants.map((assistant) => (
                    <AssistantAvatar key={assistant.name} config={assistant.config} size={20} />
                  ))}
                </span>
                <WorkspaceBreadcrumbText>{room.title}</WorkspaceBreadcrumbText>
              </span>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="flex shrink-0 items-center gap-2">
            <RoomStatus room={room} archived={archived} />
            <ThreadAccessBar
              controls={controls}
              activeIds={room.status === "open" && other ? [other.id] : []}
              pending={waitingOn ? [{ person: waitingOn }] : []}
            />
            <Popover>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <PopoverTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="What each side may share"
                        />
                      }
                    />
                  }
                >
                  <ShieldIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">What each side may share</TooltipPopup>
              </Tooltip>
              <PopoverPopup side="bottom" align="end" width="md" padding="compact">
                <div className="flex flex-col gap-3">
                  <PopoverTitle>What each side may share</PopoverTitle>
                  <RoomPolicyStrip policies={room.policies} resolveAssistant={resolveAssistant} />
                </div>
              </PopoverPopup>
            </Popover>
            <Menu>
              <MenuTrigger
                render={<Button size="icon-xs" variant="ghost" aria-label="Room actions" />}
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => setArchived(!archived)}>
                  {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                  {archived ? "Restore room" : "Archive room"}
                </MenuItem>
              </MenuPopup>
            </Menu>
            {/* Rooms only talk; nothing runs here, so just the panel toggle. */}
            <SurfaceHeaderActions
              rightPanel={{
                unavailable: "Nothing runs in a room, so there's nothing to preview yet",
              }}
            />
          </div>
        </WorkspacePageHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-(--chat-max-width) flex-col gap-6 px-4 py-6">
            {room.messages.length === 0 ? (
              <div className="flex flex-col items-center gap-2 pt-10 text-center">
                {otherAssistant ? (
                  <AssistantAvatar config={otherAssistant.config} size={48} />
                ) : null}
                <h1 className="text-base font-semibold">
                  Ask {otherAssistant?.name ?? "their assistant"}
                </h1>
                <p className="max-w-sm text-sm text-muted-foreground text-pretty">
                  {otherAssistant?.name ?? "Their assistant"} answers within{" "}
                  {other ? `${firstName(other.name)}'s` : "their"} policy.
                </p>
              </div>
            ) : (
              <RoomMessageList messages={room.messages} resolveAssistant={resolveAssistant} />
            )}
            {room.outcome ? <OutcomeCard outcome={room.outcome} /> : null}
          </div>
        </div>

        <div className="shrink-0 px-4 pb-4">
          <RoomComposer room={room} other={other} />
        </div>
      </div>
    </ProfileContainerContext>
  );
}

export function RoomPage(props: { roomId: string; containerKey: string | null }) {
  const { roomId, containerKey } = props;
  const room = useMemo(
    () => resolveRoom(roomId, containerKey ?? undefined),
    [containerKey, roomId],
  );
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      {room ? (
        <RoomView key={room.id} room={room} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <h1 className="text-base font-semibold">This room isn't here</h1>
          <p className="max-w-sm text-sm text-muted-foreground">It may have been removed.</p>
        </div>
      )}
    </SidebarInset>
  );
}
