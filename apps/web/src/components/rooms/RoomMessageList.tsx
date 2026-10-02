/**
 * Turns in a room. Assistants (both sides) speak on the left with their own
 * avatar and who they represent; an owner stepping in shows on the right. Policy
 * checks, shared contact cards, and declined requests render inline.
 */
import { ContactRoundIcon, ShieldCheckIcon, ShieldXIcon } from "lucide-react";

import { AssistantAvatar } from "../assistant/avatar";
import { MessageFiles, MessageText } from "../multiplayer/MessageText";
import { firstName, type TeamPerson } from "../multiplayer/multiplayerModel";
import type { PersonAssistant } from "../multiplayer/personAssistant";
import { PersonAvatar } from "../multiplayer/PersonAvatar";
import { findPerson } from "../multiplayer/teamThreads";
import type { RoomMessage, RoomMessageBody } from "./roomModel";

function Body(props: { body: RoomMessageBody }) {
  const { body } = props;
  if (body.kind === "policy-check") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheckIcon aria-hidden className="size-3.5 shrink-0" />
        {body.text}
      </p>
    );
  }
  if (body.kind === "contact") {
    const { contact } = body;
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm leading-relaxed text-foreground">{body.text}</p>
        <div className="flex max-w-sm items-start gap-3 rounded-lg border border-border p-3">
          <ContactRoundIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-0.5 text-sm">
            <span className="font-medium text-foreground">{contact.name}</span>
            <span className="text-muted-foreground">{contact.role}</span>
            <span className="text-foreground">{contact.email}</span>
            <span className="text-xs text-muted-foreground">{contact.context}</span>
          </div>
        </div>
      </div>
    );
  }
  if (body.kind === "declined") {
    return (
      <div className="flex max-w-sm flex-col gap-1.5 rounded-lg border border-dashed border-border p-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ShieldXIcon aria-hidden className="size-3.5 shrink-0" />
          Not shared: {body.withheld}
        </span>
        <p className="text-sm leading-relaxed text-foreground">{body.text}</p>
      </div>
    );
  }
  return <MessageText body={body.text} />;
}

function Row(props: {
  message: RoomMessage;
  resolveAssistant: (person: TeamPerson) => PersonAssistant;
}) {
  const person = findPerson(props.message.personId);
  if (!person) return null;
  const isAssistant = props.message.speaker === "assistant";
  const assistant = isAssistant ? props.resolveAssistant(person) : null;
  const owner = firstName(person.name);

  // People stepping in sit on the right, like your own turns in a chat.
  if (!assistant) {
    return (
      <li className="flex flex-row-reverse gap-3">
        <span className="pt-0.5">
          <PersonAvatar person={person} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
          <div className="flex min-w-0 flex-row-reverse items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">{person.name}</span>
            <span className="truncate text-xs text-muted-foreground">stepped in</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {props.message.at}
            </span>
          </div>
          <div className="max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
            <Body body={props.message.body} />
          </div>
          <MessageFiles files={props.message.files} />
        </div>
      </li>
    );
  }

  return (
    <li className="flex gap-3">
      <span className="pt-0.5">
        {assistant ? (
          <AssistantAvatar config={assistant.config} size={32} />
        ) : (
          <PersonAvatar person={person} />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {assistant ? assistant.name : person.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {assistant ? `represents ${assistant.isYours ? "you" : owner}` : `${owner} stepped in`}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {props.message.at}
          </span>
        </div>
        <Body body={props.message.body} />
        <MessageFiles files={props.message.files} />
      </div>
    </li>
  );
}

export function RoomMessageList(props: {
  messages: readonly RoomMessage[];
  resolveAssistant: (person: TeamPerson) => PersonAssistant;
}) {
  return (
    <ol className="flex flex-col gap-6" aria-label="Room messages">
      {props.messages.map((message) => (
        <Row key={message.id} message={message} resolveAssistant={props.resolveAssistant} />
      ))}
    </ol>
  );
}
