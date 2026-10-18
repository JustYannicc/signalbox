import {
  FileIcon,
  FilmIcon,
  FolderIcon,
  HouseIcon,
  ImageIcon,
  MicIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { CaptureFile } from "./captureAttachments";
export const SUGGESTIONS_ID = "quick-capture-folders";

export function FolderSuggestions(props: {
  readonly suggestions: ReadonlyArray<CaptureDestination>;
  readonly activeIndex: number;
  readonly onPick: (destination: CaptureDestination) => void;
  readonly onHover: (index: number) => void;
}) {
  if (props.suggestions.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No folder matches</p>;
  }
  return (
    <ul id={SUGGESTIONS_ID} role="listbox" aria-label="Folders" className="-mx-2 flex flex-col">
      {props.suggestions.map((suggestion, index) => {
        const Icon = suggestion.folderId === null ? HouseIcon : FolderIcon;
        return (
          <li
            key={suggestion.key}
            id={`${SUGGESTIONS_ID}-${index}`}
            role="option"
            aria-selected={index === props.activeIndex}
            // Keeps focus in the field while picking.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => props.onHover(index)}
            onClick={() => props.onPick(suggestion)}
            className={cn(
              "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm",
              index === props.activeIndex ? "bg-accent text-accent-foreground" : "text-foreground",
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
            {suggestion.detail ? (
              <span className="shrink-0 text-xs text-muted-foreground">{suggestion.detail}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function fileIcon(file: File): LucideIcon {
  if (file.type.startsWith("image/")) return ImageIcon;
  if (file.type.startsWith("audio/")) return MicIcon;
  if (file.type.startsWith("video/")) return FilmIcon;
  return FileIcon;
}

export function CaptureChips(props: {
  readonly picked: CaptureDestination | null;
  readonly files: ReadonlyArray<CaptureFile>;
  readonly onUnpick: () => void;
  readonly onRemoveFile: (id: string) => void;
}) {
  if (props.picked === null && props.files.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {props.picked ? (
        <Chip
          icon={
            props.picked.folderId === null ? <HouseIcon aria-hidden /> : <FolderIcon aria-hidden />
          }
          label={`#${props.picked.label}`}
          onRemove={props.onUnpick}
        />
      ) : null}
      {props.files.map(({ id, file }) => {
        const Icon = fileIcon(file);
        return (
          <Chip
            key={id}
            icon={<Icon aria-hidden />}
            label={file.name}
            detail={formatAttachmentSize(file.size)}
            onRemove={() => props.onRemoveFile(id)}
          />
        );
      })}
    </div>
  );
}

function Chip(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail?: string;
  readonly onRemove: () => void;
}) {
  return (
    <Badge variant="secondary" size="lg">
      {props.icon}
      <span className="max-w-48 truncate">{props.label}</span>
      {props.detail ? <span className="text-muted-foreground">{props.detail}</span> : null}
      <Button
        type="button"
        variant="ghost-muted"
        size="icon-micro"
        aria-label={`Remove ${props.label}`}
        onClick={props.onRemove}
        className="-mr-1"
      >
        <XIcon />
      </Button>
    </Badge>
  );
}
