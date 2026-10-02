import {
  CheckIcon,
  CircleDashedIcon,
  CornerDownRightIcon,
  LayersIcon,
  LinkIcon,
  PaperclipIcon,
} from "lucide-react";

import { useAssistantIdentity } from "../assistant/assistantIdentity";
import {
  RECENT_CAPTURES,
  withAssistantName,
  type CaptureAttachment,
  type CaptureGroup,
  type CaptureItem,
  type CaptureStatus,
} from "./captureFixtures";

function AttachmentLine({ attachment }: { attachment: CaptureAttachment }) {
  const Icon = attachment.kind === "link" ? LinkIcon : PaperclipIcon;
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{attachment.label}</span>
    </span>
  );
}

function StatusLine({ status }: { status: CaptureStatus }) {
  const assistant = useAssistantIdentity();
  const Icon =
    status.state === "done"
      ? CheckIcon
      : status.state === "pending"
        ? CircleDashedIcon
        : CornerDownRightIcon;
  return (
    <span
      className={
        status.state === "done"
          ? "flex min-w-0 items-center gap-1 text-xs text-success-foreground"
          : "flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
      }
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{withAssistantName(status.label, assistant.name)}</span>
    </span>
  );
}

function CaptureRow({ capture }: { capture: CaptureItem }) {
  return (
    <li className="flex items-start gap-3 rounded-lg px-2 py-2">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 text-sm text-foreground wrap-anywhere">{capture.text}</span>
        {capture.attachment ? <AttachmentLine attachment={capture.attachment} /> : null}
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 tabular-nums">{capture.capturedAt}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{capture.source}</span>
        </span>
        <StatusLine status={capture.status} />
      </span>
    </li>
  );
}

function CaptureGroupRow({ group }: { group: CaptureGroup }) {
  const first = group.captures[0];
  return (
    <li className="flex flex-col gap-2 rounded-lg bg-muted/40 px-2 py-2">
      <div className="flex items-start gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <LayersIcon aria-hidden className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{group.summary}</span>
          <span className="truncate text-xs text-muted-foreground">
            {first ? `${first.source} · from ${first.capturedAt}` : null}
          </span>
          <StatusLine status={{ state: "handled", label: group.outcome }} />
        </span>
      </div>
      <ol className="ms-5.5 flex flex-col gap-1.5 border-s ps-4">
        {group.captures.map((capture) => (
          <li key={capture.id} className="flex min-w-0 items-baseline gap-2 text-xs">
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {capture.capturedAt}
            </span>
            <span className="min-w-0 truncate text-foreground">{capture.text}</span>
          </li>
        ))}
      </ol>
    </li>
  );
}

/** Recent captures with where each one went. PLACEHOLDER data. */
export function RecentCaptures({ limit }: { limit?: number }) {
  const entries = limit === undefined ? RECENT_CAPTURES : RECENT_CAPTURES.slice(0, limit);
  return (
    <ul className="flex flex-col gap-1" aria-label="Recent captures">
      {entries.map((entry) =>
        entry.type === "group" ? (
          <CaptureGroupRow key={entry.group.id} group={entry.group} />
        ) : (
          <CaptureRow key={entry.capture.id} capture={entry.capture} />
        ),
      )}
    </ul>
  );
}
