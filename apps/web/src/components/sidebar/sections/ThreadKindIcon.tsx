/**
 * A row's leading type icon (task, chat, room). For chats and tasks one click
 * flips Chat ↔ Task, with an Undo toast; the kind only changes display (and
 * what the model is told), never tools. Rooms stay rooms.
 */
import { ListTodoIcon, MessageCircleIcon, MessagesSquareIcon, type LucideIcon } from "lucide-react";
import { memo } from "react";

import { toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useThreadKindStore, type ThreadKind } from "./threadKind";

export type HomeItemType = ThreadKind | "room";

export const ITEM_TYPE_ICON: Record<HomeItemType, LucideIcon> = {
  task: ListTodoIcon,
  chat: MessageCircleIcon,
  room: MessagesSquareIcon,
};

const KIND_LABEL: Record<ThreadKind, string> = { chat: "Chat", task: "Task" };

export interface KindControl {
  readonly kindKey: string;
  readonly kind: ThreadKind;
  readonly classified: ThreadKind;
  readonly overridden: boolean;
  /** Set when a Chat switched itself to Task, e.g. "started editing files 2h ago". */
  readonly switchNote: string | null;
}

export const ThreadKindIcon = memo(function ThreadKindIcon(props: {
  control: KindControl;
  title: string;
}) {
  const { kind, kindKey, classified } = props.control;
  const other: ThreadKind = kind === "chat" ? "task" : "chat";
  const switchNote = props.control.overridden ? null : props.control.switchNote;
  const Icon = ITEM_TYPE_ICON[kind];
  const tooltip = switchNote
    ? `Switched to Task (${switchNote}) · click to make it a chat`
    : `${KIND_LABEL[kind]} · click to make it a ${other}`;

  // Flipping back to the classified kind drops the override instead of storing a copy of it.
  const apply = (next: ThreadKind) => {
    const store = useThreadKindStore.getState();
    if (next === classified) store.resetKind(kindKey);
    else store.setKind(kindKey, next);
  };
  const toggle = () => {
    apply(other);
    toastManager.add({
      id: `kind-${kindKey}`,
      type: "success",
      title: `Now a ${other}`,
      timeout: 4000,
      actionProps: { children: "Undo", onClick: () => apply(kind) },
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${KIND_LABEL[kind]}: ${props.title}. Make it a ${other}`}
            onClick={toggle}
            className="relative z-10 -m-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-(--sidebar-icon-color) outline-hidden ring-ring hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:ring-2"
          />
        }
      >
        <Icon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
});
