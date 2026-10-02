/**
 * Slack-style mention pill: `@Flynn Moretti` on a tint, stronger when it is you.
 * The same pill renders in messages and inside the composer editor.
 */
import { cn } from "~/lib/utils";
import { mentionLabel, type MentionTarget } from "./mentions";
import { PersonProfilePopover } from "./PersonProfile";
import { currentPerson } from "./teamThreads";

function pillClassName(target: MentionTarget): string {
  const isYou = target.kind === "person" && target.person.id === currentPerson.id;
  return cn(
    "inline rounded-sm px-0.5 font-medium",
    isYou ? "bg-warning/16 text-warning-foreground" : "bg-info/12 text-info-foreground",
  );
}

/** In the composer: static, the editor owns selection and deletion. */
export function MentionPill(props: { target: MentionTarget }) {
  return (
    <span className={pillClassName(props.target)} contentEditable={false} spellCheck={false}>
      @{mentionLabel(props.target)}
    </span>
  );
}

/** In messages: people pills open the profile card. */
export function MessageMentionPill(props: { target: MentionTarget }) {
  const { target } = props;
  if (target.kind !== "person") {
    return <span className={pillClassName(target)}>@{mentionLabel(target)}</span>;
  }
  return (
    <PersonProfilePopover
      person={target.person}
      trigger={
        <button
          type="button"
          className={cn(
            pillClassName(target),
            "cursor-pointer outline-hidden hover:underline focus-visible:underline",
          )}
        >
          @{mentionLabel(target)}
        </button>
      }
    />
  );
}
