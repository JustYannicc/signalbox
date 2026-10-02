/**
 * Message text for team chats and rooms: plain prose with `inline code` and
 * @mention pills, plus attached files as chips. Fixtures carry nothing richer.
 */
import { FileIcon } from "lucide-react";
import { Fragment } from "react";

import { segmentMentions } from "./mentions";
import { MessageMentionPill } from "./MentionPill";

/** Splits on backticks; odd segments are code. Keys are character offsets. */
function segmentCode(body: string) {
  let offset = 0;
  return body.split("`").map((text, index) => {
    const segment = { text, isCode: index % 2 === 1, start: offset };
    offset += text.length + 1;
    return segment;
  });
}

export function MessageText(props: {
  body: string;
  /** Yours from settings. */ ownAssistantName?: string;
}) {
  return (
    <p className="text-sm leading-relaxed text-pretty text-foreground">
      {segmentCode(props.body).map((segment) =>
        segment.isCode ? (
          <code key={segment.start} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            {segment.text}
          </code>
        ) : (
          <Fragment key={segment.start}>
            {segmentMentions(segment.text, props.ownAssistantName).map((part) =>
              part.mention ? (
                <MessageMentionPill key={part.start} target={part.mention} />
              ) : (
                <Fragment key={part.start}>{part.text}</Fragment>
              ),
            )}
          </Fragment>
        ),
      )}
    </p>
  );
}

/** Attached files, by name. */
export function MessageFiles(props: { files: readonly string[] | undefined }) {
  if (!props.files || props.files.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {[...new Set(props.files)].map((name) => (
        <li
          key={name}
          className="flex max-w-60 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-foreground"
        >
          <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{name}</span>
        </li>
      ))}
    </ul>
  );
}
