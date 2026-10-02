/**
 * "Archived" at the bottom of Home: one place for everything archived —
 * real threads (from Home or the Pipeline), fixture chats and tasks, rooms,
 * projects, sections, notes — each with Restore. Projects and sections are hidden for you only.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  LayersIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadActions } from "../../../hooks/useThreadActions";
import { ALL_ROOMS, useRoomArchiveStore } from "../../rooms/rooms";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useHomeSectionStore } from "./sectionStore";
import { ITEM_TYPE_ICON } from "./ThreadKindIcon";

const KIND_ICON: Record<string, LucideIcon> = {
  Project: FolderIcon,
  Section: LayersIcon,
  Chat: ITEM_TYPE_ICON.chat,
  Task: ITEM_TYPE_ICON.task,
  Room: ITEM_TYPE_ICON.room,
  Thread: ITEM_TYPE_ICON.chat,
  Note: FileTextIcon,
};

const ARCHIVED_LIMIT = 50;

interface ArchivedRow {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly at: string;
  readonly restore: () => void;
}

export function ArchivedList(props: { archivedThreads: readonly EnvironmentThreadShell[] }) {
  const [open, setOpen] = useState(false);
  const archived = useHomeSectionStore((state) => state.archived);
  const archivedRooms = useRoomArchiveStore((state) => state.archived);
  const { unarchiveThread, unsettleThread } = useThreadActions();
  const rows: ArchivedRow[] = [
    ...Object.entries(archived).map(([key, entry]) => ({
      key,
      label: entry.label,
      kind: entry.kind,
      at: entry.archivedAt,
      restore: () => useHomeSectionStore.getState().setArchived(key, null),
    })),
    ...ALL_ROOMS.filter((room) => archivedRooms[room.id]).map((room) => ({
      key: `room:${room.id}`,
      label: room.title,
      kind: "Room",
      at: room.lastActiveAt,
      restore: () => useRoomArchiveStore.getState().setArchived(room.id, false),
    })),
    ...props.archivedThreads.map((thread) => ({
      key: `thread:${thread.environmentId}:${thread.id}`,
      label: thread.title,
      kind: "Thread",
      at: thread.archivedAt ?? thread.settledAt ?? thread.updatedAt,
      // Pipeline archives are settles; server archives come back via unarchive.
      restore: () =>
        void (thread.archivedAt === null ? unsettleThread : unarchiveThread)(
          scopeThreadRef(thread.environmentId, thread.id),
        ),
    })),
  ]
    .toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at))
    // Real thread archives go back years; the full list lives in Settings › Archived.
    .slice(0, ARCHIVED_LIMIT);
  if (rows.length === 0) return null;

  return (
    <section aria-label="Archived" className="pt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        <ArchiveIcon className="size-3.5" />
        Archived
      </button>
      {open ? (
        <ul className="flex flex-col gap-px pl-3">
          {rows.map((row) => {
            const Icon = KIND_ICON[row.kind] ?? ArchiveIcon;
            return (
              <li
                key={row.key}
                className="flex h-8 items-center gap-2 rounded-md px-2.5 text-sm text-sidebar-muted-foreground/70"
              >
                <Icon aria-label={row.kind} className="size-4 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`Restore ${row.label}`}
                        onClick={row.restore}
                        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:ring-2"
                      />
                    }
                  >
                    <ArchiveRestoreIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Restore</TooltipPopup>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
