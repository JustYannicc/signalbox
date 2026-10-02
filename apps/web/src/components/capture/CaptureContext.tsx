/**
 * The New bar's context UI: the `#`/`@` suggestion list shown while typing a
 * token, and the chip row for picked tokens, pasted links, and dropped files.
 */
import {
  AtSignIcon,
  BotIcon,
  FileIcon,
  FilmIcon,
  FolderIcon,
  ImageIcon,
  LayersIcon,
  LinkIcon,
  LockIcon,
  MessageSquareIcon,
  MicIcon,
  PlayIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { AssistantIcon, useAssistantIdentity } from "../assistant/assistantIdentity";
import { Badge } from "../ui/badge";
import {
  TOKEN_KIND_LABELS,
  formatFileSize,
  isAssistantToken,
  tokenTrigger,
  type CaptureFile,
  type CaptureLink,
  type CaptureToken,
  type CaptureTokenKind,
} from "./captureTokens";

const TOKEN_ICONS: Record<CaptureTokenKind, LucideIcon> = {
  project: FolderIcon,
  section: LayersIcon,
  chat: MessageSquareIcon,
  person: AtSignIcon,
  agent: BotIcon,
  share: UsersIcon,
  private: LockIcon,
};

function fileIcon(file: File): LucideIcon {
  if (file.type.startsWith("image/")) return ImageIcon;
  if (file.type.startsWith("audio/")) return MicIcon;
  if (file.type.startsWith("video/")) return FilmIcon;
  return FileIcon;
}

/** The assistant shows its avatar; everything else its kind's icon. */
function TokenIcon(props: { token: CaptureToken; className?: string }) {
  if (isAssistantToken(props.token)) return <AssistantIcon className="size-3.5" />;
  const Icon = TOKEN_ICONS[props.token.kind];
  return <Icon aria-hidden className={props.className} />;
}

export const CAPTURE_SUGGESTIONS_ID = "capture-suggestions";

export function captureSuggestionId(index: number): string {
  return `${CAPTURE_SUGGESTIONS_ID}-${index}`;
}

export function CaptureSuggestionList(props: {
  suggestions: ReadonlyArray<CaptureToken>;
  activeIndex: number;
  onPick: (token: CaptureToken) => void;
  onHover: (index: number) => void;
}) {
  if (props.suggestions.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No matches</p>;
  }
  return (
    <ul
      id={CAPTURE_SUGGESTIONS_ID}
      role="listbox"
      aria-label="Suggestions"
      className="flex flex-col"
    >
      {props.suggestions.map((token, index) => {
        return (
          <li
            key={token.id}
            id={captureSuggestionId(index)}
            role="option"
            aria-selected={index === props.activeIndex}
            // Keep focus in the text field while picking.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => props.onHover(index)}
            onClick={() => props.onPick(token)}
            className={cn(
              "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm",
              index === props.activeIndex ? "bg-accent text-accent-foreground" : "text-foreground",
            )}
          >
            <TokenIcon token={token} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{token.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {TOKEN_KIND_LABELS[token.kind]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Chip(props: { icon: ReactNode; label: string; detail?: string; onRemove: () => void }) {
  return (
    <Badge variant="secondary" size="lg">
      {props.icon}
      <span className="max-w-48 truncate">{props.label}</span>
      {props.detail ? <span className="text-muted-foreground">{props.detail}</span> : null}
      <button
        type="button"
        aria-label={`Remove ${props.label}`}
        onClick={props.onRemove}
        className="-mr-0.5 inline-flex cursor-pointer items-center rounded-sm text-muted-foreground hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </Badge>
  );
}

export function CaptureChipRow(props: {
  tokens: ReadonlyArray<CaptureToken>;
  links: ReadonlyArray<CaptureLink>;
  files: ReadonlyArray<CaptureFile>;
  onRemoveToken: (id: string) => void;
  onRemoveLink: (id: string) => void;
  onRemoveFile: (id: string) => void;
}) {
  const assistant = useAssistantIdentity();
  const chips: ReactNode[] = [
    ...props.tokens.map((token) => (
      <Chip
        key={token.id}
        icon={<TokenIcon token={token} />}
        label={`${tokenTrigger(token.kind)}${isAssistantToken(token) ? assistant.name : token.label}`}
        onRemove={() => props.onRemoveToken(token.id)}
      />
    )),
    ...props.links.map((link) => {
      const Icon = link.isVideo ? PlayIcon : LinkIcon;
      return (
        <Chip
          key={link.id}
          icon={<Icon aria-hidden />}
          label={link.label}
          onRemove={() => props.onRemoveLink(link.id)}
        />
      );
    }),
    ...props.files.map(({ id, file }) => {
      const Icon = fileIcon(file);
      return (
        <Chip
          key={id}
          icon={<Icon aria-hidden />}
          label={file.name}
          detail={formatFileSize(file.size)}
          onRemove={() => props.onRemoveFile(id)}
        />
      );
    }),
  ];
  if (chips.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1.5">{chips}</div>;
}
