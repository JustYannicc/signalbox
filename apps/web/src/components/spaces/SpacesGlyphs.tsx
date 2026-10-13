/**
 * Marks for Spaces: one per source, one glyph per item type, and the sync dot.
 * Sources show their service's brand mark (a monochrome glyph for Signalbox's
 * own pages and services without one) on a framed tile, so they never read as
 * item types.
 */
import {
  CircleDotIcon,
  DropletIcon,
  FilePenLineIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypeIcon,
  ImageIcon,
  ImagesIcon,
  LinkIcon,
  MailIcon,
  MessageSquareTextIcon,
  NotebookPenIcon,
  PresentationIcon,
  SquareCheckIcon,
  StickyNoteIcon,
  type LucideIcon,
} from "lucide-react";
import { createElement } from "react";

import { cn } from "~/lib/utils";
import { BrandMark } from "../brand/BrandMark";
import type { BrandId } from "../brand/brandMarks";
import type { SpacesConnector, SpacesItemType, SpacesSyncState } from "./spacesFixtures";

// Signalbox's own pages, and services Simple Icons has no mark for, keep a glyph.
const CONNECTOR_MARK: Record<SpacesConnector, BrandId | LucideIcon> = {
  notes: NotebookPenIcon,
  drive: "googleDrive",
  photos: "googlePhotos",
  notion: "notion",
  github: "github",
  gmail: "gmail",
  raindrop: DropletIcon,
  todoist: "todoist",
  trello: "trello",
  slack: "slack",
  jira: "jira",
  confluence: "confluence",
  sentry: "sentry",
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
  const mark = CONNECTOR_MARK[props.connector];
  const iconClass = props.size === "md" ? "size-3.5" : "size-3";
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
      {typeof mark === "string" ? (
        <BrandMark brand={mark} className={iconClass} />
      ) : (
        createElement(mark, { className: iconClass, strokeWidth: 2.25 })
      )}
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
