/**
 * Monochrome marks for Spaces: one glyph per source, one per item type, and
 * the sync dot. Sources get a framed tile so they never read as item types.
 * No brand artwork: the real integrations can bring their own marks later.
 */
import {
  ApertureIcon,
  BookOpenIcon,
  CircleDotIcon,
  Columns3Icon,
  DropletIcon,
  FilePenLineIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypeIcon,
  GitBranchIcon,
  HardDriveIcon,
  HashIcon,
  ImageIcon,
  ImagesIcon,
  InboxIcon,
  LinkIcon,
  ListChecksIcon,
  MailIcon,
  MessageSquareTextIcon,
  NotebookIcon,
  NotebookPenIcon,
  PresentationIcon,
  SirenIcon,
  SquareCheckIcon,
  SquareKanbanIcon,
  StickyNoteIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import type { SpacesConnector, SpacesItemType, SpacesSyncState } from "./spacesFixtures";

const CONNECTOR_ICON: Record<SpacesConnector, LucideIcon> = {
  notes: NotebookPenIcon,
  drive: HardDriveIcon,
  photos: ApertureIcon,
  notion: NotebookIcon,
  github: GitBranchIcon,
  gmail: InboxIcon,
  raindrop: DropletIcon,
  todoist: ListChecksIcon,
  trello: Columns3Icon,
  slack: HashIcon,
  jira: SquareKanbanIcon,
  confluence: BookOpenIcon,
  sentry: SirenIcon,
};

const TYPE_ICON: Record<SpacesItemType, LucideIcon> = {
  doc: FileTextIcon,
  sheet: FileSpreadsheetIcon,
  slides: PresentationIcon,
  page: StickyNoteIcon,
  note: FilePenLineIcon,
  pdf: FileTypeIcon,
  image: ImageIcon,
  album: ImagesIcon,
  issue: CircleDotIcon,
  task: SquareCheckIcon,
  message: MessageSquareTextIcon,
  email: MailIcon,
  link: LinkIcon,
};

export function SourceMark(props: {
  connector: SpacesConnector;
  size?: "sm" | "md";
  tone?: "page" | "sidebar";
}) {
  const Icon = CONNECTOR_ICON[props.connector];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border",
        props.size === "md" ? "size-7" : "size-5",
        props.tone === "sidebar"
          ? "border-sidebar-border bg-sidebar-control-surface text-sidebar-foreground"
          : "border-border bg-card text-foreground",
      )}
    >
      <Icon className={props.size === "md" ? "size-3.5" : "size-3"} strokeWidth={2.25} />
    </span>
  );
}

export function ItemTypeIcon(props: { type: SpacesItemType; className?: string }) {
  const Icon = TYPE_ICON[props.type];
  return <Icon aria-hidden className={cn("size-4 shrink-0", props.className)} />;
}

const SYNC_DOT_CLASS: Record<SpacesSyncState, string> = {
  synced: "bg-success",
  // Static on purpose: a pulsing dot repaints forever.
  syncing: "bg-info",
  error: "bg-error",
};

export function SyncDot(props: { state: SpacesSyncState; label: string }) {
  return (
    <span
      role="img"
      aria-label={props.label}
      className={cn("size-1.5 shrink-0 rounded-full", SYNC_DOT_CLASS[props.state])}
    />
  );
}
