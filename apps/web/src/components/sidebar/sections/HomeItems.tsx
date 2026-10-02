/**
 * Everything a container lists besides projects: loose chats and tasks, team
 * threads, rooms, and real threads moved in, newest first. Same row anatomy
 * for all of them; each opens, archives, and moves.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { memo, useState, type ReactNode } from "react";

import { roomAccessBase, teamThreadAccessBase } from "../../multiplayer/itemAccess";
import type { TeamThread } from "../../multiplayer/multiplayerModel";
import { currentPerson } from "../../multiplayer/teamThreads";
import type { Room } from "../../rooms/roomModel";
import { useRoomArchiveStore } from "../../rooms/rooms";
import { toastManager } from "../../ui/toast";
import { useSidebar } from "../../ui/sidebar";
import { homeThreadKey } from "../useHomeSidebarData";
import { roomNeedsYou, teamThreadWaitingOn, type ContainerContents } from "./containerContents";
import { HomeItemRow } from "./HomeItemRow";
import { signalsForTeamThread } from "./itemSignals";
import type { LooseItem } from "./sectionModel";
import { archiveInHome } from "./sectionStore";
import { MentionMarker, ScopeMarker } from "./StatusMarkers";
import { taskSwitchNote, useThreadKind } from "./threadKind";
import { useItemScope } from "./useItemScope";
import { useOpenSharedThread } from "./useOpenSharedThread";

const kindLabel = (kind: "chat" | "task") => (kind === "chat" ? "Chat" : "Task");

interface RowPlace {
  readonly containerKey: string;
  /** Multiplayer container id, for the scope marker. */
  readonly containerId: string;
  /** Whether archiving should mention that others still see it. */
  readonly sharedContainer: boolean;
}

const LooseItemRow = memo(function LooseItemRow(props: {
  item: LooseItem;
  place: RowPlace;
  isActive: boolean;
}) {
  const { item, place } = props;
  const { open } = useOpenSharedThread();
  // The fixture's type stands in for Jev's call.
  const { kind, overridden } = useThreadKind(item.id, item.type);
  const scope = useItemScope({
    id: item.id,
    title: item.title,
    kind: item.type,
    containerId: place.containerId,
    ownerIds: [currentPerson.id],
    repliedIds: [],
    initialVisibility: item.scope,
  });
  return (
    <HomeItemRow
      type={kind}
      title={item.title}
      isActive={props.isActive}
      onOpen={() => open(item.id)}
      kind={{ kindKey: item.id, kind, classified: item.type, overridden, switchNote: null }}
      status={item.status ?? null}
      markers={<ScopeMarker scope={scope} />}
      lastActiveAt={item.lastActiveAt}
      onArchive={() =>
        archiveInHome(item.id, item.title, kindLabel(kind), {
          sharedWithOthers: place.sharedContainer,
        })
      }
      movable={{ kind: "item", key: item.id, label: item.title }}
      containerKey={place.containerKey}
    />
  );
});

const TeamThreadRow = memo(function TeamThreadRow(props: {
  thread: TeamThread;
  place: RowPlace;
  isActive: boolean;
}) {
  const { thread, place } = props;
  const { open } = useOpenSharedThread();
  // The fixture's kind stands in for Jev's call.
  const { kind, overridden } = useThreadKind(thread.id, thread.kind);
  const signals = signalsForTeamThread(thread.id);
  const scope = useItemScope({ ...teamThreadAccessBase(thread), containerId: place.containerId });
  return (
    <HomeItemRow
      type={kind}
      title={thread.title}
      isActive={props.isActive}
      onOpen={() => open(thread.id)}
      kind={{
        kindKey: thread.id,
        kind,
        classified: thread.kind,
        overridden,
        switchNote: thread.switchedToTaskAt ? taskSwitchNote(thread.switchedToTaskAt) : null,
      }}
      status={signals.status ?? null}
      waitingOnId={teamThreadWaitingOn(thread)}
      markers={
        <>
          {signals.mentionedById ? <MentionMarker personId={signals.mentionedById} /> : null}
          <ScopeMarker scope={scope} />
        </>
      }
      lastActiveAt={thread.lastActiveAt}
      onArchive={() =>
        archiveInHome(thread.id, thread.title, kindLabel(kind), {
          sharedWithOthers: scope.deviation !== "private-in-shared" && place.sharedContainer,
        })
      }
      movable={{ kind: "item", key: thread.id, label: thread.title }}
      containerKey={place.containerKey}
    />
  );
});

function archiveRoom(room: Room) {
  const { setArchived } = useRoomArchiveStore.getState();
  setArchived(room.id, true);
  toastManager.add({
    id: `room-archive-${room.id}`,
    type: "success",
    title: `Archived ${room.title}`,
    timeout: 5000,
    actionProps: { children: "Undo", onClick: () => setArchived(room.id, false) },
  });
}

const RoomRow = memo(function RoomRow(props: { room: Room; place: RowPlace; isActive: boolean }) {
  const { room, place } = props;
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const scope = useItemScope({ ...roomAccessBase(room), containerId: place.containerId });
  const waitingOn =
    room.status === "open" && room.waitingOnId !== currentPerson.id ? room.waitingOnId : null;
  return (
    <HomeItemRow
      type="room"
      title={room.title}
      isActive={props.isActive}
      onOpen={() => {
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/rooms/$roomId", params: { roomId: room.id } });
      }}
      status={roomNeedsYou(room) ? "input" : room.status === "done" ? "done" : null}
      {...(room.status === "done" ? { statusTooltip: "Done" } : {})}
      waitingOnId={waitingOn ?? null}
      markers={<ScopeMarker scope={scope} />}
      lastActiveAt={room.lastActiveAt}
      onArchive={() => archiveRoom(room)}
      movable={{ kind: "item", key: room.id, label: room.title }}
      containerKey={place.containerKey}
    />
  );
});

type Entry =
  | { readonly type: "loose"; readonly at: string; readonly item: LooseItem }
  | { readonly type: "team"; readonly at: string; readonly thread: TeamThread }
  | { readonly type: "room"; readonly at: string; readonly room: Room }
  | { readonly type: "real"; readonly at: string; readonly thread: EnvironmentThreadShell };

/** A container's items, newest first. Real threads render through `renderThread`. */
export function ContainerItems(props: {
  contents: ContainerContents;
  place: RowPlace;
  renderThread: (thread: EnvironmentThreadShell) => ReactNode;
  /** Show this many, with "Show N more" for the rest. */
  limit?: number;
  /** Real thread key that is open, so it never hides past the cut. */
  activeThreadKey?: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const activeId = useLocation({
    select: (location) => {
      const match = /^\/(?:shared|rooms)\/([^/]+)/.exec(location.pathname);
      return match?.[1] ? decodeURIComponent(match[1]) : null;
    },
  });
  const { contents, place } = props;
  const entries: Entry[] = [
    ...contents.loose.map((item) => ({ type: "loose" as const, at: item.lastActiveAt, item })),
    ...contents.teamThreads.map((thread) => ({
      type: "team" as const,
      at: thread.lastActiveAt,
      thread,
    })),
    ...contents.rooms.map((room) => ({ type: "room" as const, at: room.lastActiveAt, room })),
    ...contents.threads.map((thread) => ({
      type: "real" as const,
      at: thread.latestUserMessageAt ?? thread.updatedAt,
      thread,
    })),
  ].toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at));

  const entryId = (entry: Entry) =>
    entry.type === "real"
      ? homeThreadKey(entry.thread)
      : entry.type === "loose"
        ? entry.item.id
        : entry.type === "team"
          ? entry.thread.id
          : entry.room.id;
  const activeIndex = entries.findIndex((entry) => {
    const id = entryId(entry);
    return id === activeId || id === props.activeThreadKey;
  });
  const limit = props.limit ?? entries.length;
  const cut = showAll || activeIndex >= limit ? entries.length : limit;

  const rows = entries.slice(0, cut).map((entry) => {
    if (entry.type === "real") return props.renderThread(entry.thread);
    if (entry.type === "loose") {
      return (
        <LooseItemRow
          key={entry.item.id}
          item={entry.item}
          place={place}
          isActive={entry.item.id === activeId}
        />
      );
    }
    if (entry.type === "team") {
      return (
        <TeamThreadRow
          key={entry.thread.id}
          thread={entry.thread}
          place={place}
          isActive={entry.thread.id === activeId}
        />
      );
    }
    return (
      <RoomRow
        key={entry.room.id}
        room={entry.room}
        place={place}
        isActive={entry.room.id === activeId}
      />
    );
  });
  if (entries.length <= limit || activeIndex >= limit) return rows;
  return (
    <>
      {rows}
      <li>
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="flex h-7 w-full cursor-pointer items-center rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          {showAll ? "Show less" : `Show ${entries.length - limit} more`}
        </button>
      </li>
    </>
  );
}

export type { RowPlace };
